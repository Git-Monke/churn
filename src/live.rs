//! A live, rolling view of the output of a long-running command.
//!
//! Only a handful of informative lines are kept so the user can see Docker
//! pulling, creating and starting containers while a spinner keeps the screen
//! alive during quiet stretches.

use std::collections::VecDeque;
use std::fmt::Display;

use cliclack::{ProgressBar, spinner};
use console::Term;

/// How many log lines to keep on screen.
const WINDOW: usize = 5;

/// The kinds of Compose output worth showing.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineKind {
    /// Pull/create/start/error milestones: always appended.
    Milestone,
    /// Layer download/extract updates: replace the previous activity line.
    Activity,
}

/// Decide whether a Compose line is worth showing and how it should be treated.
pub fn classify(line: &str) -> Option<LineKind> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let lower = line.to_ascii_lowercase();

    const PROBLEMS: &[&str] = &[
        "error",
        "failed",
        "failure",
        "warning",
        "denied",
        "cannot",
        "unable",
        "not found",
    ];
    if PROBLEMS.iter().any(|needle| lower.contains(needle)) {
        return Some(LineKind::Milestone);
    }

    const MILESTONES: &[&str] = &[
        "pulled",
        "created",
        "started",
        "recreated",
        "stopped",
        "removed",
        "healthy",
        "waiting",
        "building",
        "built",
        "network",
        "container",
        "volume",
    ];
    if line.starts_with("[+]") || MILESTONES.iter().any(|needle| lower.contains(needle)) {
        return Some(LineKind::Milestone);
    }

    // A pull that has just begun has no progress counters yet.
    if lower.ends_with("pulling") || lower.ends_with("waiting") {
        return Some(LineKind::Milestone);
    }

    const ACTIVITY: &[&str] = &[
        "downloading",
        "extracting",
        "pulling",
        "waiting",
        "building",
    ];
    if ACTIVITY.iter().any(|needle| lower.contains(needle)) {
        return Some(LineKind::Activity);
    }

    None
}

/// A spinner with a rolling window of the most recent interesting output lines.
///
/// When stderr is not a terminal the lines are written plainly instead of using
/// cursor movement.
pub struct LiveLog {
    bar: Option<ProgressBar>,
    title: String,
    lines: VecDeque<String>,
    last_is_activity: bool,
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
            lines: VecDeque::new(),
            last_is_activity: false,
            width: term.size().1 as usize,
        }
    }

    /// Add one output line. Lines classified as noise are ignored.
    pub fn push(&mut self, line: &str) {
        let Some(kind) = classify(line) else {
            return;
        };
        let line = self.shorten(line);

        let Some(bar) = &self.bar else {
            eprintln!("  {line}");
            return;
        };

        if kind == LineKind::Activity && self.last_is_activity {
            self.lines.pop_back();
        }
        while self.lines.len() >= WINDOW {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
        self.last_is_activity = kind == LineKind::Activity;
        bar.set_message(render(&self.title, &self.lines));
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

/// Title first, then the newest log line, then older lines.
fn render(title: &str, lines: &VecDeque<String>) -> String {
    let mut message = title.to_string();
    for line in lines.iter().rev() {
        message.push('\n');
        message.push('│');
        message.push_str("  ");
        message.push_str(line);
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn milestones_are_kept() {
        for line in [
            "[+] Pulling 4/4",
            " ✔ gluetun Pulled",
            " ✔ Container qbittorrent Started",
            " ✔ Network torrent_default Created",
            "⠿ gluetun Pulling",
            "error: pull access denied",
        ] {
            assert_eq!(classify(line), Some(LineKind::Milestone), "{line:?}");
        }
    }

    #[test]
    fn layer_progress_is_activity() {
        for line in [
            "982c2f Pulling fs layer",
            "Downloading [====>     ] 12MB/45MB",
            "Extracting [==========] 100%",
        ] {
            assert_eq!(classify(line), Some(LineKind::Activity), "{line:?}");
        }
    }

    #[test]
    fn unimportant_lines_are_dropped() {
        for line in ["", "   ", "some image metadata"] {
            assert_eq!(classify(line), None, "{line:?}");
        }
    }

    #[test]
    fn window_is_rendered_newest_first_with_bar_prefixes() {
        let mut lines = VecDeque::new();
        lines.push_back("oldest".to_string());
        lines.push_back("middle".to_string());
        lines.push_back("newest".to_string());

        assert_eq!(
            render("[1/2] starting torrent", &lines),
            "[1/2] starting torrent\n│  newest\n│  middle\n│  oldest"
        );
    }
}
