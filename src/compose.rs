//! Parsed events from `docker compose --progress json`.
//!
//! Compose emits one JSON object per line. Layer events carry the owning image
//! in `parent_id`, so they can be folded into a single row for that image
//! instead of filling the screen with one row per layer.

use serde::Deserialize;

/// One event from Compose's JSON progress stream.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct Event {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub parent_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub details: String,
    #[serde(default)]
    pub current: u64,
    #[serde(default)]
    pub total: u64,
    #[serde(default)]
    pub percent: u32,
}

impl Event {
    /// Parse one line of Compose output, returning `None` for non-JSON lines.
    pub fn parse(line: &str) -> Option<Self> {
        let event: Self = serde_json::from_str(line.trim()).ok()?;
        (!event.key().is_empty()).then_some(event)
    }

    /// The process this event updates.
    ///
    /// Layer events use the layer digest as `id` and the image as `parent_id`;
    /// grouping by the parent gives one row per image. Container, network and
    /// volume events have no parent, so their own id is used.
    pub fn key(&self) -> &str {
        if self.parent_id.is_empty() {
            &self.id
        } else {
            &self.parent_id
        }
    }

    /// A single human-readable line describing this event's latest state.
    pub fn line(&self) -> String {
        let mut line = self.key().to_string();
        if !self.text.is_empty() {
            line.push_str(" · ");
            line.push_str(&self.text);
        }
        if !self.details.is_empty() && self.details != self.text {
            line.push(' ');
            line.push_str(&self.details);
        }
        if self.percent > 0 && self.percent < 100 && !self.details.contains('%') {
            line.push_str(&format!(" ({}%)", self.percent));
        }
        line
    }
}

/// One service row from `docker compose ps --format json`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct PsService {
    #[serde(default, rename = "Service")]
    pub service: String,
    #[serde(default, rename = "Publishers")]
    pub publishers: Vec<PsPublisher>,
}

/// One published host port on a service row.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct PsPublisher {
    #[serde(default, rename = "URL")]
    pub url: String,
    #[serde(default, rename = "TargetPort")]
    pub target_port: u16,
    #[serde(default, rename = "PublishedPort")]
    pub published_port: u16,
    #[serde(default, rename = "Protocol")]
    pub protocol: String,
}

/// Parse `docker compose ps --format json`; an empty project prints nothing.
pub fn parse_ps(output: &str) -> serde_json::Result<Vec<PsService>> {
    let output = output.trim();
    if output.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(output)
}

/// Format a raw Compose tail line for an error message.
pub fn describe(line: &str) -> String {
    Event::parse(line)
        .map(|event| event.line())
        .unwrap_or_else(|| line.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layer_events_are_grouped_under_their_image() {
        let event = Event::parse(
            r#"{"id":"982c2f","parent_id":"Image jellyfin/jellyfin:10.11.11","status":"Working","text":"Downloading","details":"12.3MB","percent":42}"#,
        )
        .expect("layer event");

        assert_eq!(event.key(), "Image jellyfin/jellyfin:10.11.11");
        assert_eq!(
            event.line(),
            "Image jellyfin/jellyfin:10.11.11 · Downloading 12.3MB (42%)"
        );
    }

    #[test]
    fn container_events_use_their_own_id() {
        let event = Event::parse(r#"{"id":"Container jellyfin","status":"Done","text":"Started"}"#)
            .expect("container event");

        assert_eq!(event.key(), "Container jellyfin");
        assert_eq!(event.line(), "Container jellyfin · Started");
    }

    #[test]
    fn non_json_lines_are_not_events() {
        assert_eq!(Event::parse("plain docker output"), None);
        assert_eq!(Event::parse(r#"{"status":"Working"}"#), None);
    }

    #[test]
    fn raw_lines_survive_error_descriptions() {
        assert_eq!(describe("  plain docker warning\n"), "plain docker warning");
    }

    #[test]
    fn compose_ps_publishers_are_parsed() {
        let services = parse_ps(
            r#"[{"Service":"gluetun","Publishers":[
                {"URL":"0.0.0.0","TargetPort":8080,"PublishedPort":8081,"Protocol":"tcp"},
                {"URL":"127.0.0.1","TargetPort":8098,"PublishedPort":8098,"Protocol":"tcp"}
            ]}]"#,
        )
        .unwrap();

        assert_eq!(services[0].service, "gluetun");
        assert_eq!(services[0].publishers[1].published_port, 8098);
        assert_eq!(services[0].publishers[1].url, "127.0.0.1");
    }

    #[test]
    fn empty_compose_ps_output_is_an_empty_list() {
        assert!(parse_ps("  \n").unwrap().is_empty());
    }
}
