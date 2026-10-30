//! A live view of the output of a long-running command.
//!
//! Compose runs pulls, creates and starts in parallel. Instead of keeping the
//! last few lines overall, each process keeps only its latest line, so one
//! chatty image or layer cannot push another process out of view.

use std::fmt::Display;

use cliclack::{ProgressBar, spinner};
use console::Term;

use crate::compose::Event;

/// One row in the live view: the latest event for a single process.
struct ProcessLine {
    key: String,
    line: String,
}

/// A spinner with one line per process, updated in place.
///
/// When stderr is not a terminal the lines are written plainly instead of using
/// cursor movement.
pub struct LiveLog {
    bar: Option<ProgressBar>,
    title: String,
    processes: Vec<ProcessLine>,
    width: usize,
}

impl LiveLog {
    /// Start the live view. `title` stays visible until the view is finished.
    pub fn start(title: impl Display) -> Self {
        let title = title.to_string();
        let term = Term::stderr();
        let bar = if term.is_term() {
            let bar = spinner();
            bar.start(&title);
            Some(bar)
        } else {
            eprintln!("{title}");
            None
        };

        Self {
            bar,
            title,
            processes: Vec::new(),
            width: term.size().1 as usize,
        }
    }

    /// Update the latest line for the event's process.
    pub fn push(&mut self, raw: &str) {
        let Some(event) = Event::parse(raw) else {
            return;
        };
        let key = event.key().to_string();
        let line = self.shorten(&event.line());

        let Some(bar) = &self.bar else {
            eprintln!("  {line}");
            return;
        };

        if let Some(process) = self.processes.iter_mut().find(|process| process.key == key) {
            process.line = line;
        } else {
            self.processes.push(ProcessLine { key, line });
        }
        bar.set_message(render(&self.title, &self.processes));
    }

    fn shorten(&self, line: &str) -> String {
        let width = self.width.saturating_sub(4).max(20);
        console::truncate_str(line, width, "…").into_owned()
    }

    /// Finish successfully, replacing the live view with a single line.
    pub fn success(mut self, message: impl Display) {
        if let Some(bar) = self.bar.take() {
            // Clear the multiline spinner first: finishing it directly leaves
            // the old window behind.
            bar.clear();
            let _ = cliclack::log::success(message);
        } else {
            eprintln!("{message}");
        }
    }

    /// Finish with an error, replacing the live view with a single line.
    pub fn error(mut self, message: impl Display) {
        if let Some(bar) = self.bar.take() {
            bar.clear();
            let _ = cliclack::log::error(message);
        } else {
            eprintln!("{message}");
        }
    }
}

impl Drop for LiveLog {
    fn drop(&mut self) {
        // Clear on Ctrl-C or an unexpected early return; after `success`/`error`
        // the bar is already taken and this is a no-op.
        if let Some(bar) = self.bar.take() {
            bar.clear();
        }
    }
}

/// Title first, then one stable row per process in first-seen order.
fn render(title: &str, processes: &[ProcessLine]) -> String {
    let mut message = title.to_string();
    for process in processes {
        message.push('\n');
        message.push('│');
        message.push_str("  ");
        message.push_str(&process.line);
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_process_keeps_only_its_latest_line() {
        let mut processes: Vec<ProcessLine> = Vec::new();

        for (key, line) in [
            ("Image jellyfin", "Image jellyfin · Pulling"),
            ("Image sonarr", "Image sonarr · Pulling"),
            ("Image jellyfin", "Image jellyfin · Downloading 50%"),
            ("Image sonarr", "Image sonarr · Pull complete"),
        ] {
            if let Some(process) = processes.iter_mut().find(|process| process.key == key) {
                process.line = line.to_string();
            } else {
                processes.push(ProcessLine {
                    key: key.to_string(),
                    line: line.to_string(),
                });
            }
        }

        assert_eq!(
            render("[1/2] starting server", &processes),
            "[1/2] starting server\n\
             │  Image jellyfin · Downloading 50%\n\
             │  Image sonarr · Pull complete"
        );
    }
}
