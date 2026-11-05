//! A live view of the output of a long-running command.
//!
//! Compose runs pulls, creates and starts in parallel. Instead of keeping the
//! last few lines overall, each process keeps only its latest line, so one
//! chatty image or layer cannot push another process out of view.

use std::fmt::Display;

use cliclack::{ProgressBar, progress_bar, spinner};
use console::Term;

use crate::compose::Event;

/// Detail line first, then the bar itself.
///
/// `{msg}` expands to the title plus the live figures, and indicatif draws the
/// bar on its own line so a wide path in the title cannot squeeze it.
const PROGRESS_TEMPLATE: &str = "{msg}\n{bar:30.cyan/blue} {percent}% · {elapsed_precise}";

/// One row in the live view: the latest event for a single process.
struct ProcessLine {
    key: String,
    line: String,
}

/// A spinner or a determinate bar, updated in place.
///
/// When stderr is not a terminal the lines are written plainly instead of using
/// cursor movement. Determinate bars print at most one line per 10% there, so a
/// long copy cannot flood a log file.
pub struct LiveLog {
    bar: Option<ProgressBar>,
    title: String,
    processes: Vec<ProcessLine>,
    width: usize,
    /// Bar length; `None` for an indeterminate spinner.
    len: Option<u64>,
    last_decile: Option<u8>,
}

impl LiveLog {
    /// Start the live view. `title` stays visible until the view is finished.
    pub fn start(title: impl Display) -> Self {
        Self::new(title, None)
    }

    /// Start a determinate bar of `len` units, driven by [`LiveLog::update`].
    pub fn progress(title: impl Display, len: u64) -> Self {
        Self::new(title, Some(len.max(1)))
    }

    fn new(title: impl Display, len: Option<u64>) -> Self {
        let title = title.to_string();
        let term = Term::stderr();
        let bar = if term.is_term() {
            let bar = match len {
                // Always percent-wide: `update` converts its position using the
                // `len` the caller chose, which may be bytes, files or frames.
                Some(_) => progress_bar(100).with_template(PROGRESS_TEMPLATE),
                None => spinner(),
            };
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
            len,
            last_decile: None,
        }
    }

    /// Move the bar and replace its detail line.
    ///
    /// `position` is in the units given to [`LiveLog::progress`]. Detail is shown
    /// next to the title on a terminal and after the percentage otherwise.
    pub fn update(&mut self, position: u64, detail: impl Display) {
        let detail = detail.to_string();
        let Some(len) = self.len else {
            return;
        };
        let percent = (position.saturating_mul(100) / len).min(100);

        let Some(bar) = &self.bar else {
            if let Some(decile) = next_decile(self.last_decile, percent) {
                self.last_decile = Some(decile);
                eprintln!("  {percent}% · {detail}");
            }
            return;
        };

        let message = format!("{} · {detail}", self.title);
        bar.set_message(self.shorten(&message));
        bar.set_position(percent);
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

/// The 10%-wide bucket a percentage falls in, or `None` when `last` already
/// reported that bucket. Keeps non-terminal output to ~11 lines per copy.
fn next_decile(last: Option<u8>, percent: u64) -> Option<u8> {
    let decile = (percent / 10).min(10) as u8;
    (last != Some(decile)).then_some(decile)
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
    fn cliclack_accepts_the_progress_template() {
        // `start` unwraps the parsed template, so this catches a typo even
        // though the test's stderr is not a terminal and nothing is drawn.
        let bar = progress_bar(100).with_template(PROGRESS_TEMPLATE);
        bar.start("copying /old to /new · 1.2 GiB · 3.00GB/s · ETA 0:00:12");
        bar.set_position(45);
        bar.stop("copied 1.2 GiB");
    }

    #[test]
    fn non_terminal_bars_report_one_line_per_decile() {
        let mut last = None;
        let mut printed = 0;
        for percent in 0..=100 {
            if let Some(decile) = next_decile(last, percent) {
                last = Some(decile);
                printed += 1;
            }
        }
        assert_eq!(printed, 11, "0%, 10%, …, 100%");

        // Repeated updates inside the same decile print nothing.
        assert_eq!(next_decile(None, 0), Some(0));
        assert_eq!(next_decile(Some(0), 3), None);
        assert_eq!(next_decile(Some(0), 9), None);
        assert_eq!(next_decile(Some(0), 10), Some(1));
        assert_eq!(next_decile(Some(9), 100), Some(10));
    }

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
