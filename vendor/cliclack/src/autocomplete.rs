use console::Key;

use crate::{prompt::interaction::State, theme::THEME, Suggest};

pub(crate) struct Autocomplete {
    /// The list of suggestions to be rendered.
    source: Box<dyn Suggest<Result = String>>,
    /// The list of suggestions to be rendered.
    items: Vec<String>,
    /// The index of the currently selected suggestion (unselected by default).
    cursor: Option<usize>,
}

impl Autocomplete {
    /// Creates a new autocompletion popup with the given suggestions.
    pub fn new<S>(suggestions: S) -> Self
    where
        S: Suggest<Result = String> + 'static,
    {
        Self {
            source: Box::new(suggestions),
            items: Vec::new(),
            cursor: None,
        }
    }

    /// Tracks the state of the autocompletion popup.
    pub fn on(&mut self, key: &Key, query: &str) -> Option<State<String>> {
        if self.items.is_empty() {
            self.items = self.source.suggest(query);
            self.cursor = if self.items.is_empty() { None } else { Some(0) };
            return None;
        }

        let len = self.items.len();

        // Temporarily cap the cursor, in case the suggestions list has shrunk.
        // It allows to keep the original cursor position unless arrows are pressed.
        let cursor = self.cursor.unwrap_or(0).min(len - 1);

        match key {
            // Move the cursor up in a circular manner.
            Key::ArrowUp => self.cursor = Some(cursor.saturating_sub(1) % len),
            // Move the cursor down in a circular manner.
            Key::ArrowDown => self.cursor = Some((cursor + 1) % len),
            // Complete the highlighted suggestion but keep the prompt open.
            // Enter is intentionally not handled here: it must submit the
            // typed value, not the suggestion, or one keypress would both
            // complete and submit.
            Key::Tab => {
                let accepted = self
                    .cursor
                    .map(|_| State::Submit(self.items[cursor].clone()));
                if accepted.is_some() {
                    // Refresh against the completed value on the next keypress
                    // instead of re-offering the same stale suggestion.
                    self.items.clear();
                    self.cursor = None;
                }
                return accepted;
            }
            // Enter submits the typed value; do not accept a suggestion here.
            Key::Enter => return None,
            // Hide the autocompletion drop-down, and tell the prompt to not close the entire app.
            Key::Escape => {
                self.items.clear();
                self.cursor = None;
                return Some(State::Cancel);
            }
            // Other keys may clear suggestions if the query is empty.
            _ if query.is_empty() => {
                self.items.clear();
                self.cursor = None;
            }
            // Other keys refresh the suggestions and highlight the first one.
            _ => {
                self.items = self.source.suggest(query);
                self.cursor = if self.items.is_empty() { None } else { Some(0) };
            }
        }
        None
    }

    /// Renders autocomplete popup suggestions under the input line.
    pub fn render<T>(&self, state: &State<T>) -> String {
        match state {
            State::Submit(_) | State::Cancel => return String::new(),
            _ => {}
        }

        if self.items.is_empty() {
            return String::new();
        }

        // Temporarily cap the cursor, in case the suggestions list has shrunk.
        // It allows to keep the original cursor position unless arrows are pressed.
        let cursor = self.cursor.map(|line| line.min(self.items.len() - 1));

        let theme = THEME.read().unwrap();

        let empty_line = [/*theme.format_autocomplete_item(&state.into(), false, "")*/].into_iter();
        let items = self.items.iter().enumerate().map(|(i, item)| {
            theme.format_autocomplete_item(&state.into(), cursor == Some(i), item)
        });

        empty_line.chain(items).collect()
    }
}
