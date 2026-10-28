//! The questions each installer can ask, deduplicated by the orchestrator.

use std::fs::{self, OpenOptions};
use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cliclack::{input, log};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Section {
    Vpn,
    Storage,
}

impl Section {
    /// VPN credentials are always collected before the storage path.
    pub const ORDER: [Section; 2] = [Section::Vpn, Section::Storage];
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Question {
    DataDir,
    WireguardArchive,
    WireguardConfig,
    WireguardPrivateKey,
    WireguardAddresses,
}

impl Question {
    /// Every variant, used to prefill answers from a previous `.env`.
    pub const ALL: [Question; 5] = [
        Question::DataDir,
        Question::WireguardArchive,
        Question::WireguardConfig,
        Question::WireguardPrivateKey,
        Question::WireguardAddresses,
    ];

    /// Answers filled in from the archive, shown in the plan but never asked.
    pub const DETAILS: [Question; 3] = [
        Question::WireguardConfig,
        Question::WireguardPrivateKey,
        Question::WireguardAddresses,
    ];

    pub fn section(self) -> Section {
        match self {
            Question::WireguardArchive
            | Question::WireguardConfig
            | Question::WireguardPrivateKey
            | Question::WireguardAddresses => Section::Vpn,
            Question::DataDir => Section::Storage,
        }
    }

    /// Name of the key this answer is stored under in `.env`.
    pub fn env_key(self) -> &'static str {
        match self {
            Question::DataDir => "DATA_DIR",
            Question::WireguardArchive => "WIREGUARD_ARCHIVE",
            Question::WireguardConfig => "WIREGUARD_CONFIG",
            Question::WireguardPrivateKey => "WIREGUARD_PRIVATE_KEY",
            Question::WireguardAddresses => "WIREGUARD_ADDRESSES",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Question::DataDir => "Where should media and downloads live?",
            Question::WireguardArchive => "Path to the Mullvad WireGuard config zip",
            Question::WireguardConfig => "WireGuard config file",
            Question::WireguardPrivateKey => "WireGuard private key",
            Question::WireguardAddresses => "WireGuard interface address",
        }
    }

    pub fn is_secret(self) -> bool {
        matches!(self, Question::WireguardPrivateKey)
    }

    /// Ask, offering `stored` (from a previous run) as the default.
    ///
    /// Validation is handled here rather than with `Input::validate` so that a
    /// rejected answer gets a fresh prompt: cliclack keeps the typed buffer on
    /// error, which makes a mistyped path impossible to correct.
    pub fn ask(self, stored: Option<&str>) -> io::Result<String> {
        match self {
            Question::DataDir => {
                let mut default = stored
                    .map(normalize_path)
                    .unwrap_or_else(|| "/data".to_string());
                loop {
                    let value: String = input(self.label())
                        .placeholder("/data")
                        .default_input(&default)
                        .autocomplete(directory_suggestions)
                        .interact()?;
                    let normalized = normalize_path(&value);
                    match validate_data_dir(&normalized) {
                        Ok(()) => return Ok(normalized),
                        Err(message) => {
                            log::error(message)?;
                            default = normalized;
                        }
                    }
                }
            }
            Question::WireguardArchive => {
                let mut default = stored.map(normalize_path).unwrap_or_default();
                loop {
                    let mut prompt = input(self.label())
                        .placeholder("~/Downloads/mullvad_wireguard_linux_us_all.zip")
                        .autocomplete(file_path_suggestions);
                    if !default.is_empty() {
                        prompt = prompt.default_input(&default);
                    }
                    let value: String = prompt.interact()?;
                    let path = expand_tilde(value.trim());
                    let display = path.to_string_lossy().to_string();
                    match crate::mullvad::entries(&path) {
                        Ok(_) => return Ok(display),
                        Err(message) => {
                            log::error(message)?;
                            default = display;
                        }
                    }
                }
            }
            Question::WireguardConfig
            | Question::WireguardPrivateKey
            | Question::WireguardAddresses => Err(io::Error::other(
                "internal error: WireGuard credentials come from the config archive",
            )),
        }
    }
}

// -------------------------------------------------------------------- validation
pub fn expand_tilde(value: &str) -> PathBuf {
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = home_dir() {
            return home.join(value.strip_prefix("~/").unwrap_or(""));
        }
    }
    PathBuf::from(value)
}

/// Home directory for `~` expansion.
///
/// Under `sudo`, `HOME` points at root's home while the person typing `~/...`
/// means the account that invoked sudo. Prefer that account when it is known.
fn home_dir() -> Option<PathBuf> {
    sudo_user_home().or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

fn sudo_user_home() -> Option<PathBuf> {
    let user = std::env::var("SUDO_USER").ok();
    let uid = std::env::var("SUDO_UID").ok();
    if user.is_none() && uid.is_none() {
        return None;
    }
    let passwd = fs::read_to_string("/etc/passwd").ok()?;
    home_from_passwd(&passwd, user.as_deref(), uid.as_deref())
}

fn home_from_passwd(contents: &str, user: Option<&str>, uid: Option<&str>) -> Option<PathBuf> {
    for line in contents.lines() {
        let fields: Vec<&str> = line.split(':').collect();
        if fields.len() < 7 {
            continue;
        }
        let matches_user = user.is_some_and(|user| user == fields[0]);
        let matches_uid = uid.is_some_and(|uid| uid == fields[2]);
        if matches_user || matches_uid {
            return Some(PathBuf::from(fields[5]));
        }
    }
    None
}

pub fn normalize_path(value: &str) -> String {
    let mut normalized = expand_tilde(value).to_string_lossy().to_string();
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

/// Suggestions for prompts that accept a file or directory path.
fn file_path_suggestions(input: &str) -> Vec<String> {
    complete_paths(input, true)
}

/// Suggestions for prompts that only accept a directory path.
fn directory_suggestions(input: &str) -> Vec<String> {
    complete_paths(input, false)
}

/// Complete the last path component, keeping the prefix the user typed.
///
/// Directories are returned with a trailing slash so pressing the completion
/// again continues inside them.
fn complete_paths(input: &str, include_files: bool) -> Vec<String> {
    const MAX_SUGGESTIONS: usize = 25;

    let (dir_part, prefix) = match input.rsplit_once('/') {
        Some((dir, name)) => (format!("{dir}/"), name),
        None => (String::new(), input),
    };
    let read_dir = if dir_part.is_empty() {
        PathBuf::from(".")
    } else {
        expand_tilde(&dir_part)
    };
    let Ok(entries) = fs::read_dir(read_dir) else {
        return Vec::new();
    };
    let prefix = prefix.to_lowercase();

    let mut suggestions: Vec<(bool, String, String)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.to_lowercase().starts_with(&prefix) {
                return None;
            }
            // Only offer dotfiles when the user is explicitly typing a dot.
            if !prefix.starts_with('.') && name.starts_with('.') {
                return None;
            }
            let is_dir = entry.file_type().ok()?.is_dir();
            if !is_dir && !include_files {
                return None;
            }
            let mut suggestion = format!("{dir_part}{name}");
            if is_dir {
                suggestion.push('/');
            }
            // Directories first, then alphabetically.
            Some((!is_dir, name.to_lowercase(), suggestion))
        })
        .collect();

    suggestions.sort();
    suggestions.truncate(MAX_SUGGESTIONS);
    suggestions
        .into_iter()
        .map(|(_, _, suggestion)| suggestion)
        .collect()
}

pub fn validate_data_dir(value: &str) -> Result<(), String> {
    let path = expand_tilde(value);
    if value.trim().is_empty() {
        return Err("A path is required.".into());
    }
    if !path.is_absolute() {
        return Err("Needs to be an absolute path, e.g. /data/media.".into());
    }
    if path.exists() {
        if !path.is_dir() {
            return Err(format!("{} exists but is not a directory.", path.display()));
        }
        if !is_writable(&path) {
            return Err(format!("{} is not writable by this user.", path.display()));
        }
        return Ok(());
    }
    let ancestor = nearest_existing(&path);
    if !is_writable(&ancestor) {
        return Err(format!(
            "Cannot create {}: {} is not writable.",
            path.display(),
            ancestor.display()
        ));
    }
    Ok(())
}

/// Actually attempt a write, since permission bits alone lie about ownership.
fn is_writable(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let probe = dir.join(format!(".churn-write-test-{}", std::process::id()));
    let created = OpenOptions::new().write(true).create_new(true).open(&probe);
    match created {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn nearest_existing(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    current
}

pub fn validate_wireguard_key(value: &str) -> Result<(), String> {
    let decoded = STANDARD.decode(value).map_err(
        |_| "Not valid base64 — copy the \"PrivateKey\" value from the Mullvad .conf config.",
    )?;
    match decoded.len() {
        32 => Ok(()),
        other => Err(format!(
            "Decoded to {other} bytes, expected 32 — this may be the Mullvad account key instead of a WireGuard key."
        )),
    }
}

pub fn validate_wireguard_address(value: &str) -> Result<(), String> {
    let (address, prefix) = value
        .split_once('/')
        .ok_or_else(|| "Expected CIDR notation, e.g. 10.64.12.34/32.".to_string())?;
    address.parse::<Ipv4Addr>().map_err(|_| {
        "Not an IPv4 address — use the IPv4 \"Address\" entry from the config file.".to_string()
    })?;
    let prefix: u8 = prefix
        .parse()
        .map_err(|_| "The /prefix after the slash must be a number, usually 32.".to_string())?;
    if prefix > 32 {
        return Err("The /prefix cannot be greater than 32.".into());
    }
    Ok(())
}

#[cfg(test)]
mod path_completion_tests {
    use super::*;

    fn fixture(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("churn-complete-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("Downloads")).unwrap();
        fs::create_dir_all(dir.join(".hidden-dir")).unwrap();
        fs::write(dir.join("notes.txt"), "").unwrap();
        fs::write(dir.join(".hidden.txt"), "").unwrap();
        dir
    }

    #[test]
    fn completes_directories_and_files() {
        let dir = fixture("files");
        let prefix = dir.to_string_lossy();

        assert_eq!(
            complete_paths(&format!("{prefix}/Down"), true),
            vec![format!("{prefix}/Downloads/")]
        );
        assert_eq!(
            complete_paths(&format!("{prefix}/notes"), true),
            vec![format!("{prefix}/notes.txt")]
        );
        // Directories come first and get a trailing slash.
        let all = complete_paths(&format!("{prefix}/"), true);
        assert_eq!(all[0], format!("{prefix}/Downloads/"));
        assert!(!all.iter().any(|entry| entry.ends_with(".hidden.txt")));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn directory_prompts_do_not_suggest_files() {
        let dir = fixture("dirs");
        let prefix = dir.to_string_lossy();

        assert_eq!(
            complete_paths(&format!("{prefix}/notes"), false),
            Vec::<String>::new()
        );
        assert!(
            complete_paths(&format!("{prefix}/"), false)
                .iter()
                .all(|entry| entry.ends_with('/'))
        );

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sudo_user_home_is_resolved_through_passwd() {
        let passwd = "\
root:x:0:0:root:/root:/bin/bash
monke:x:1000:1000::/home/monke:/bin/bash
";
        assert_eq!(
            home_from_passwd(passwd, Some("monke"), None),
            Some(PathBuf::from("/home/monke"))
        );
        assert_eq!(
            home_from_passwd(passwd, None, Some("1000")),
            Some(PathBuf::from("/home/monke"))
        );
        assert_eq!(home_from_passwd(passwd, Some("nobody"), None), None);
    }

    #[test]
    fn dotfiles_are_suggested_only_after_a_dot() {
        let dir = fixture("dots");
        let prefix = dir.to_string_lossy();

        assert!(
            complete_paths(&format!("{prefix}/.hidden"), true)
                .iter()
                .any(|entry| entry.ends_with(".hidden.txt"))
        );

        fs::remove_dir_all(&dir).unwrap();
    }
}

/// Redact a secret for the confirmation summary.
pub fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.is_empty() {
        return "(unset)".into();
    }
    if chars.len() <= 10 {
        return format!("{}…", chars.iter().take(2).collect::<String>());
    }
    let head: String = chars.iter().take(4).collect();
    let tail: String = chars.iter().skip(chars.len() - 2).collect();
    format!("{head}…{tail} ({} chars)", chars.len())
}
