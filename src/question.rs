//! The questions each installer can ask, deduplicated by the orchestrator.

use std::fs::{self, OpenOptions};
use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cliclack::{input, log, password};

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
    WireguardPrivateKey,
    WireguardAddresses,
    ServerCountries,
}

impl Question {
    pub fn section(self) -> Section {
        match self {
            Question::WireguardPrivateKey
            | Question::WireguardAddresses
            | Question::ServerCountries => Section::Vpn,
            Question::DataDir => Section::Storage,
        }
    }

    /// Name of the key this answer is stored under in `.env`.
    pub fn env_key(self) -> &'static str {
        match self {
            Question::DataDir => "DATA_DIR",
            Question::WireguardPrivateKey => "WIREGUARD_PRIVATE_KEY",
            Question::WireguardAddresses => "WIREGUARD_ADDRESSES",
            Question::ServerCountries => "SERVER_COUNTRIES",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Question::DataDir => "Where should media and downloads live?",
            Question::WireguardPrivateKey => "WireGuard private key",
            Question::WireguardAddresses => "WireGuard interface address",
            Question::ServerCountries => "Preferred server countries",
        }
    }

    pub fn is_secret(self) -> bool {
        matches!(self, Question::WireguardPrivateKey)
    }

    /// Ask, offering `stored` (from a previous run) as the default.
    ///
    /// Validation is handled here rather than with `Input::validate` so that a
    /// rejected answer gets a fresh prompt: cliclack keeps the typed buffer on
    /// error, which makes a mistyped 44-character key impossible to correct.
    pub fn ask(self, stored: Option<&str>) -> io::Result<String> {
        match self {
            Question::DataDir => {
                let mut default = stored.map(normalize_path).unwrap_or_else(|| "/data".to_string());
                loop {
                    let value: String = input(self.label())
                        .placeholder("/data")
                        .default_input(&default)
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
            Question::WireguardPrivateKey => loop {
                let mut prompt = password(self.label()).mask('▪');
                if stored.is_some() {
                    prompt = prompt.allow_empty();
                }
                let value: String = prompt.interact()?;
                if value.is_empty() {
                    return Ok(stored.unwrap_or_default().to_string());
                }
                match validate_wireguard_key(&value) {
                    Ok(()) => return Ok(value),
                    Err(message) => log::error(message)?,
                }
            },
            Question::WireguardAddresses => loop {
                let mut prompt = input(self.label()).placeholder("10.64.12.34/32");
                if let Some(previous) = stored {
                    prompt = prompt.default_input(previous);
                }
                let value: String = prompt.interact()?;
                match validate_wireguard_address(&value) {
                    Ok(()) => return Ok(value),
                    Err(message) => log::error(message)?,
                }
            },
            Question::ServerCountries => loop {
                let value: String = input(self.label())
                    .placeholder("Netherlands,Sweden")
                    .default_input(stored.unwrap_or("Netherlands"))
                    .interact()?;
                match validate_countries(&value) {
                    Ok(()) => return Ok(value),
                    Err(message) => log::error(message)?,
                }
            },
        }
    }
}

// -------------------------------------------------------------------- validation
pub fn expand_tilde(value: &str) -> PathBuf {
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(value.trim_start_matches("~/"));
        }
    }
    PathBuf::from(value)
}

pub fn normalize_path(value: &str) -> String {
    let mut normalized = expand_tilde(value).to_string_lossy().to_string();
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
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
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| "Not valid base64 — copy the \"PrivateKey\" value from the Mullvad .json config.")?;
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
    address
        .parse::<Ipv4Addr>()
        .map_err(|_| "Not an IPv4 address — use the IPv4 \"Address\" entry from the config file.".to_string())?;
    let prefix: u8 = prefix
        .parse()
        .map_err(|_| "The /prefix after the slash must be a number, usually 32.".to_string())?;
    if prefix > 32 {
        return Err("The /prefix cannot be greater than 32.".into());
    }
    Ok(())
}

pub fn validate_countries(value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err("Give at least one country, or edit SERVER_COUNTRIES in torrent/.env later.".into());
    }
    Ok(())
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
