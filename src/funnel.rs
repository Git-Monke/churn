//! Tailscale Funnel state for the dashboard.
//!
//! The dashboard is exposed on a fixed port (8443) so an existing Tailscale
//! serve on 443 is never touched. Everything that inspects or changes the serve
//! configuration lives here; the CLI only decides what to ask and when.

use std::collections::BTreeMap;
use std::io;
use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::envfile;
use crate::stack::Stack;
use crate::system;

/// The public HTTPS port churn claims. Any other port is not ours to touch.
pub const HTTPS_PORT: u16 = 8443;
/// The `.env` key the dashboard reads to accept passkey requests.
pub const ORIGIN_ENV: &str = "CHURN_PASSKEY_ORIGIN";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Node {
    pub dns_name: String,
}

impl Node {
    /// The public dashboard URL.
    pub fn url(&self) -> String {
        format!("https://{}:{}", self.dns_name, HTTPS_PORT)
    }

    /// The local address Funnel forwards to for `dashboard_port`.
    fn target(&self, dashboard_port: u16) -> String {
        format!("http://127.0.0.1:{dashboard_port}")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    /// The configured proxy for the 8443 handler, when one exists.
    pub proxy: Option<String>,
    /// Whether `AllowFunnel` is on for the 8443 handler.
    pub funnel_on: bool,
    /// Whether the proxy is this dashboard's local address.
    pub ours: bool,
}

/// The running Tailscale node, when there is one.
pub fn detect() -> Option<Node> {
    if !system::which("tailscale") {
        return None;
    }
    let json = run(&["status", "--json"]).ok()?;
    parse_node(&json)
}

/// Whether the churn install owns the 8443 handler.
///
/// `CHURN_PASSKEY_ORIGIN` survives a dashboard port change, so it is the only
/// marker that distinguishes a stale churn handler from somebody else's.
pub fn owns(node: &Node) -> bool {
    let env = envfile::read(&Stack::Server.env_path());
    env.get(ORIGIN_ENV)
        .is_some_and(|value| *value == node.url())
}

pub fn status(node: &Node, dashboard_port: u16) -> io::Result<Status> {
    let json = run(&["funnel", "status", "--json"])?;
    let config = parse_config(&json).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("could not parse `tailscale funnel status --json`: {err}"),
        )
    })?;
    Ok(status_from(&config, node, dashboard_port))
}

/// Point the 8443 handler at the dashboard and enable Funnel for it.
pub fn enable(node: &Node, dashboard_port: u16) -> io::Result<()> {
    let current = status(node, dashboard_port)?;
    if let Some(proxy) = foreign_proxy(&current)
        && !owns(node)
    {
        return Err(io::Error::other(format!(
            "Tailscale already serves {proxy} on {}; refusing to replace it",
            node.url()
        )));
    }
    if current.funnel_on && current.ours {
        return Ok(());
    }

    let target = node.target(dashboard_port);
    let https = format!("--https={HTTPS_PORT}");
    run(&["funnel", "--bg", "--yes", &https, "--set-path=/", &target])?;

    let after = status(node, dashboard_port)?;
    if !(after.funnel_on && after.ours) {
        return Err(io::Error::other(
            "tailscale funnel reported success but the 8443 handler is not funnel-enabled",
        ));
    }
    Ok(())
}

/// Remove the 8443 handler without touching the rest of the serve config.
///
/// `tailscale funnel reset` would clear unrelated serve configuration, so the
/// single path is turned off instead.
pub fn disable(node: &Node, dashboard_port: u16) -> io::Result<()> {
    let current = status(node, dashboard_port)?;
    if let Some(proxy) = foreign_proxy(&current)
        && !owns(node)
    {
        return Err(io::Error::other(format!(
            "Tailscale is serving {proxy} on {}; refusing to disable it",
            node.url()
        )));
    }
    if current.proxy.is_none() && !current.funnel_on {
        return Ok(());
    }

    let https = format!("--https={HTTPS_PORT}");
    run(&["funnel", "--bg", &https, "--set-path=/", "off"])?;

    let after = status(node, dashboard_port)?;
    if after.proxy.is_some() || after.funnel_on {
        return Err(io::Error::other(
            "tailscale funnel reported success but the 8443 handler is still configured",
        ));
    }
    Ok(())
}

/// Write the passkey origin the dashboard expects. Churn owns this key.
pub fn save_origin(node: &Node) -> io::Result<()> {
    envfile::upsert(&Stack::Server.env_path(), ORIGIN_ENV, &node.url())
}

/// Remove the passkey origin, but only when it is ours.
///
/// A manually configured origin points somewhere else and must survive.
pub fn clear_origin(node: &Node) -> io::Result<()> {
    let env = envfile::read(&Stack::Server.env_path());
    if env
        .get(ORIGIN_ENV)
        .is_some_and(|value| *value == node.url())
    {
        envfile::remove_keys(&Stack::Server.env_path(), &[ORIGIN_ENV])?;
    }
    Ok(())
}

fn foreign_proxy(status: &Status) -> Option<&str> {
    status.proxy.as_deref().filter(|_| !status.ours)
}

/// Run the Tailscale CLI, keeping its diagnostics for the error message.
fn run(args: &[&str]) -> io::Result<String> {
    let output = Command::new("tailscale")
        .args(args)
        .stdin(Stdio::null())
        .output()?;
    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let details = [stderr, stdout]
            .into_iter()
            .filter(|stream| !stream.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(io::Error::other(format!(
            "tailscale {} failed with {}: {details}",
            args.join(" "),
            output.status
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_config(json: &str) -> serde_json::Result<ServeConfig> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(ServeConfig::default());
    }
    serde_json::from_str(trimmed)
}

fn status_from(config: &ServeConfig, node: &Node, dashboard_port: u16) -> Status {
    let key = format!("{}:{}", node.dns_name, HTTPS_PORT);
    let proxy = config
        .web
        .get(&key)
        .and_then(|server| server.handlers.get("/"))
        .and_then(|handler| handler.proxy.clone());
    let funnel_on = config.allow_funnel.get(&key).copied().unwrap_or(false);
    let target = node.target(dashboard_port);
    let ours = proxy
        .as_deref()
        .is_some_and(|proxy| proxy.trim_end_matches('/') == target.as_str());
    Status {
        proxy,
        funnel_on,
        ours,
    }
}

fn parse_node(json: &str) -> Option<Node> {
    let status: NodeStatus = serde_json::from_str(json).ok()?;
    if status.backend_state != "Running" {
        return None;
    }
    let dns_name = status
        .this
        .dns_name
        .trim()
        .trim_end_matches('.')
        .to_string();
    if dns_name.is_empty() {
        return None;
    }
    Some(Node { dns_name })
}

#[derive(Debug, Default, Deserialize)]
struct ServeConfig {
    #[serde(rename = "Web", default)]
    web: BTreeMap<String, WebServer>,
    #[serde(rename = "AllowFunnel", default)]
    allow_funnel: BTreeMap<String, bool>,
}

#[derive(Debug, Default, Deserialize)]
struct WebServer {
    #[serde(rename = "Handlers", default)]
    handlers: BTreeMap<String, Handler>,
}

#[derive(Debug, Deserialize)]
struct Handler {
    #[serde(rename = "Proxy")]
    proxy: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NodeStatus {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    this: SelfNode,
}

#[derive(Debug, Deserialize)]
struct SelfNode {
    #[serde(rename = "DNSName")]
    dns_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node() -> Node {
        Node {
            dns_name: "host.ts.net".to_string(),
        }
    }

    #[test]
    fn parses_a_tailnet_only_serve() {
        let config = parse_config(
            r#"{"Web":{"host.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5173"}}}}}"#,
        )
        .expect("valid serve config");
        let status = status_from(&config, &node(), 4000);
        assert_eq!(status.proxy, None);
        assert!(!status.funnel_on);
        assert!(!status.ours);
    }

    #[test]
    fn parses_a_funnel_on_8443() {
        let config = parse_config(
            r#"{"TCP":{"8443":{"HTTPS":true}},"Web":{"host.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4000"}}}},"AllowFunnel":{"host.ts.net:8443":true}}"#,
        )
        .expect("valid serve config");
        let status = status_from(&config, &node(), 4000);
        assert_eq!(status.proxy.as_deref(), Some("http://127.0.0.1:4000"));
        assert!(status.funnel_on);
        assert!(status.ours);
    }

    #[test]
    fn treats_empty_status_as_off() {
        for json in ["", "{}", "null"] {
            let config = parse_config(json).expect("empty config");
            let status = status_from(&config, &node(), 4000);
            assert_eq!(status.proxy, None, "{json:?}");
            assert!(!status.funnel_on, "{json:?}");
            assert!(!status.ours, "{json:?}");
        }
    }

    #[test]
    fn rejects_a_foreign_handler() {
        let config = parse_config(
            r#"{"Web":{"host.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5173"}}}},"AllowFunnel":{"host.ts.net:8443":true}}"#,
        )
        .expect("valid serve config");
        let status = status_from(&config, &node(), 4000);
        assert!(!status.ours);
        assert_eq!(foreign_proxy(&status), Some("http://127.0.0.1:5173"));
    }

    #[test]
    fn reads_the_running_node() {
        let node = parse_node(r#"{"BackendState":"Running","Self":{"DNSName":"host.ts.net."}}"#)
            .expect("running node");
        assert_eq!(node.dns_name, "host.ts.net");
        assert_eq!(node.url(), "https://host.ts.net:8443");
        assert!(
            parse_node(r#"{"BackendState":"Stopped","Self":{"DNSName":"host.ts.net."}}"#).is_none()
        );
        assert!(parse_node("not json").is_none());
    }
}
