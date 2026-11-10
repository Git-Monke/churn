//! The questions each installer can ask, deduplicated by the orchestrator.

use std::fs::{self, OpenOptions};
use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cliclack::{input, log, password, select};

use crate::ports::{self, Port};
use crate::vpn::VpnProvider;

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
    DownloadDir,
    MediaDir,
    Port(Port),
    VpnProvider,
    WireguardPrivateKey,
    WireguardAddresses,
    OpenvpnUser,
    OpenvpnPassword,
    VpnLocation,
}

impl Question {
    /// Every variant, used to prefill answers from a previous `.env`.
    pub const ALL: [Question; 15] = [
        Question::DownloadDir,
        Question::MediaDir,
        Question::Port(Port::Jellyfin),
        Question::Port(Port::Sonarr),
        Question::Port(Port::Radarr),
        Question::Port(Port::Dashboard),
        Question::Port(Port::Qbittorrent),
        Question::Port(Port::Prowlarr),
        Question::Port(Port::VpnStatus),
        Question::VpnProvider,
        Question::WireguardPrivateKey,
        Question::WireguardAddresses,
        Question::OpenvpnUser,
        Question::OpenvpnPassword,
        Question::VpnLocation,
    ];

    pub fn section(self) -> Section {
        match self {
            Question::VpnProvider
            | Question::WireguardPrivateKey
            | Question::WireguardAddresses
            | Question::OpenvpnUser
            | Question::OpenvpnPassword
            | Question::VpnLocation => Section::Vpn,
            Question::DownloadDir | Question::MediaDir | Question::Port(_) => Section::Storage,
        }
    }

    /// Name of the key this answer is stored under in `.env`.
    ///
    /// [`Question::VpnProvider`] stores Gluetun's own `VPN_SERVICE_PROVIDER`
    /// value, and [`Question::VpnLocation`] stores the neutral `VPN_LOCATION`.
    /// Both round-trip: a rerun reads back exactly what it wrote.
    pub fn env_key(self) -> &'static str {
        match self {
            Question::DownloadDir => "DOWNLOAD_DIR",
            Question::MediaDir => "MEDIA_DIR",
            Question::Port(port) => port.env_key(),
            Question::VpnProvider => "VPN_SERVICE_PROVIDER",
            Question::WireguardPrivateKey => "WIREGUARD_PRIVATE_KEY",
            Question::WireguardAddresses => "WIREGUARD_ADDRESSES",
            Question::OpenvpnUser => "OPENVPN_USER",
            Question::OpenvpnPassword => "OPENVPN_PASSWORD",
            Question::VpnLocation => "VPN_LOCATION",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Question::DownloadDir => "Where should in-progress downloads live?",
            Question::MediaDir => "Where should downloaded media be stored?",
            Question::Port(port) => port.label(),
            Question::VpnProvider => "Which VPN do you use?",
            Question::WireguardPrivateKey => "WireGuard private key",
            Question::WireguardAddresses => "WireGuard interface address",
            Question::OpenvpnUser => "OpenVPN username",
            Question::OpenvpnPassword => "OpenVPN password",
            Question::VpnLocation => "Which server location?",
        }
    }

    /// Questions whose answer must never appear in a plan summary or a log.
    pub fn is_secret(self) -> bool {
        matches!(
            self,
            Question::WireguardPrivateKey | Question::OpenvpnPassword
        )
    }

    /// Whether this question is part of `provider`'s configured protocol.
    ///
    /// The wizard asks the provider first and then drops everything that does
    /// not apply, so a ProtonVPN user is never shown an OpenVPN password prompt
    /// and a PIA user is never asked for a WireGuard key.
    pub fn applies_to(self, provider: VpnProvider) -> bool {
        match self {
            Question::WireguardPrivateKey => provider.uses_wireguard(),
            Question::WireguardAddresses => provider.needs_address(),
            Question::OpenvpnUser | Question::OpenvpnPassword => !provider.uses_wireguard(),
            Question::VpnProvider | Question::VpnLocation => true,
            Question::DownloadDir | Question::MediaDir | Question::Port(_) => true,
        }
    }

    /// The question that owns `env_key`, for reading a stored `.env` value
    /// back into an answer. Ports and the provider share the reverse lookup.
    pub fn from_env_key(key: &str) -> Option<Question> {
        Question::ALL
            .into_iter()
            .find(|question| question.env_key() == key)
    }

    /// The provider stored in `answers`, falling back to the default.
    pub fn provider_from(value: Option<&str>) -> VpnProvider {
        value
            .and_then(VpnProvider::from_gluetun_id)
            .unwrap_or(VpnProvider::DEFAULT)
    }

    /// Port prompt used by the resolver. Rejects ports another churn service
    /// has already claimed, and ports that are currently in use.
    pub fn ask_port(self, port: Port, suggested: u16, reserved: &[u16]) -> io::Result<String> {
        let mut default = suggested.to_string();
        loop {
            // Let cliclack render the default as "8081 (default)". Setting a
            // separate placeholder here made the prompt show the conventional
            // port (8080) while Enter actually submitted the suggested one.
            let value: String = input(self.label()).default_input(&default).interact()?;
            let candidate = match ports::validate_port(value.trim()) {
                Ok(candidate) => candidate,
                Err(message) => {
                    log::error(message)?;
                    default = value.trim().to_string();
                    continue;
                }
            };
            if reserved.contains(&candidate) {
                log::error(format!(
                    "Port {candidate} is already assigned to another churn service."
                ))?;
                default = candidate.to_string();
                continue;
            }
            if !port.is_free(candidate) {
                log::error(format!(
                    "Port {candidate} is already in use on this machine."
                ))?;
                default = candidate.to_string();
                continue;
            }
            return Ok(candidate.to_string());
        }
    }

    /// Ask, offering `stored` (from a previous run) as the default.
    ///
    /// Validation is handled here rather than with `Input::validate` so that a
    /// rejected answer gets a fresh prompt: cliclack keeps the typed buffer on
    /// error, which makes a mistyped path impossible to correct.
    pub fn ask(self, stored: Option<&str>, stored_provider: Option<&str>) -> io::Result<String> {
        match self {
            Question::DownloadDir => ask_directory(self.label(), stored.or(Some("/data")), "/data"),
            // The media default is derived from the download answer, which this
            // call cannot see, so the caller passes it in as `stored`.
            Question::MediaDir => ask_directory(self.label(), stored, "/data/media"),
            Question::Port(port) => {
                let default = stored
                    .and_then(|value| ports::validate_port(value).ok())
                    .unwrap_or_else(|| port.default_port());
                self.ask_port(port, default, &[])
            }
            Question::VpnProvider => Ok(ask_provider(stored)?.gluetun_id().to_string()),
            Question::WireguardPrivateKey => ask_wireguard_key(stored),
            Question::WireguardAddresses => ask_wireguard_address(stored),
            Question::OpenvpnUser => ask_openvpn_user(stored),
            Question::OpenvpnPassword => ask_openvpn_password(),
            Question::VpnLocation => {
                let provider = Question::provider_from(stored_provider);
                ask_location(provider, stored)
            }
        }
    }
}

/// Ask which provider this install tunnels through.
fn ask_provider(stored: Option<&str>) -> io::Result<VpnProvider> {
    let current = Question::provider_from(stored);
    let mut prompt = select("Which VPN do you use?");
    for provider in VpnProvider::ALL {
        prompt = prompt.item(provider, provider.label(), provider.hint());
    }
    prompt.initial_value(current).interact()
}

fn ask_wireguard_key(stored: Option<&str>) -> io::Result<String> {
    let mut default = stored.map(str::trim).unwrap_or_default().to_string();
    loop {
        let mut prompt = input(Question::WireguardPrivateKey.label())
            .placeholder("wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=");
        if !default.is_empty() {
            prompt = prompt.default_input(&default);
        }
        let value: String = prompt.interact()?;
        match validate_wireguard_key(value.trim()) {
            Ok(()) => return Ok(value.trim().to_string()),
            Err(message) => {
                log::error(message)?;
                default.clear();
            }
        }
    }
}

fn ask_wireguard_address(stored: Option<&str>) -> io::Result<String> {
    let default = stored.map(str::trim).unwrap_or_default().to_string();
    loop {
        let mut prompt = input(Question::WireguardAddresses.label())
            .placeholder("10.64.0.2/32")
            .validate(|value: &String| validate_wireguard_address(value.trim()));
        if !default.is_empty() {
            prompt = prompt.default_input(&default);
        }
        match prompt.interact::<String>() {
            Ok(value) => return Ok(value.trim().to_string()),
            // cliclack keeps the rejected buffer on error, which turns a typo
            // into an uncorrectable prompt; start over with the same default.
            Err(error) => log::error(error.to_string())?,
        }
    }
}

fn ask_openvpn_user(stored: Option<&str>) -> io::Result<String> {
    let default = stored.map(str::trim).unwrap_or_default().to_string();
    loop {
        let mut prompt = input(Question::OpenvpnUser.label())
            .placeholder("p1234567")
            .validate(|value: &String| {
                if value.trim().is_empty() {
                    Err("An OpenVPN username is required.".to_string())
                } else {
                    Ok(())
                }
            });
        if !default.is_empty() {
            prompt = prompt.default_input(&default);
        }
        match prompt.interact::<String>() {
            Ok(value) => return Ok(value.trim().to_string()),
            Err(error) => log::error(error.to_string())?,
        }
    }
}

/// A password is never prefilled: an empty prompt is a deliberate re-entry, not
/// a lost answer, and cliclack cannot show a default without leaking its length.
fn ask_openvpn_password() -> io::Result<String> {
    loop {
        match password(Question::OpenvpnPassword.label())
            .mask('*')
            .interact()
        {
            Ok(value) => return Ok(value),
            Err(error) => log::error(error.to_string())?,
        }
    }
}

/// Location picker: filterable, restricted to the provider's embedded list.
fn ask_location(provider: VpnProvider, stored: Option<&str>) -> io::Result<String> {
    let locations = provider.locations();
    let current = stored.map(str::trim).unwrap_or_default();
    // Case-insensitive match, so a hand-edited `netherlands` still lands on the
    // right entry instead of silently defaulting to the first one.
    let initial = locations
        .iter()
        .copied()
        .find(|known| known.eq_ignore_ascii_case(current))
        .unwrap_or_else(|| {
            provider
                .default_location()
                .unwrap_or_else(|| locations.first().copied().unwrap_or("Netherlands"))
        });

    let mut prompt = select(format!("Which {} location?", provider.label()))
        .filter_mode()
        .max_rows(12);
    for location in locations {
        prompt = prompt.item(*location, *location, String::new());
    }
    // `T` is `&'static str` here so the embedded list is never copied; the
    // answer is owned from the moment it leaves the prompt.
    prompt.initial_value(initial).interact().map(str::to_string)
}

/// Ask for a writable directory with the same completion rules as the installer.
///
/// `stored` prefills the prompt; passing `None` leaves the placeholder as the
/// only hint. Rejected answers get a fresh prompt instead of keeping cliclack's
/// typed buffer, which makes a mistyped path impossible to correct.
pub fn ask_directory(prompt: &str, stored: Option<&str>, placeholder: &str) -> io::Result<String> {
    let mut default = stored.map(normalize_path);
    loop {
        let mut prompt = input(prompt)
            .placeholder(placeholder)
            .autocomplete(directory_suggestions);
        if let Some(default) = &default {
            prompt = prompt.default_input(default);
        }
        let value: String = prompt.interact()?;
        let normalized = normalize_path(&value);
        match validate_data_dir(&normalized) {
            Ok(()) => return Ok(normalized),
            Err(message) => {
                log::error(message)?;
                default = Some(normalized);
            }
        }
    }
}

// -------------------------------------------------------------------- validation
pub fn expand_tilde(value: &str) -> PathBuf {
    if (value == "~" || value.starts_with("~/"))
        && let Some(home) = home_dir()
    {
        return home.join(value.strip_prefix("~/").unwrap_or(""));
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

/// Validate the storage pair as a whole.
///
/// `MEDIA_DIR` nested inside `DOWNLOAD_DIR` is the default layout and is fine:
/// finished downloads land inside the directory Jellyfin indexes. The reverse
/// is not: Jellyfin would index files that are still downloading (partials,
/// temp files), so equal paths and a download directory inside the media
/// directory are rejected. Both sides are normalized but never canonicalized,
/// because the directories usually do not exist yet.
pub fn validate_storage_paths(download: &str, media: &str) -> Result<(), String> {
    let download = PathBuf::from(normalize_path(download));
    let media = PathBuf::from(normalize_path(media));
    if download == media {
        return Err(format!(
            "The download directory and the media directory cannot be the same path ({}).\n\
             Keep downloads outside the library: Jellyfin would index files that are still downloading.",
            download.display()
        ));
    }
    if download.starts_with(&media) {
        return Err(format!(
            "The download directory ({}) cannot live inside the media directory ({}).\n\
             Jellyfin would index files that are still downloading, and partial files would show up in your library.",
            download.display(),
            media.display()
        ));
    }
    Ok(())
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
        |_| "Not valid base64 — copy the \"PrivateKey\" value from your provider's WireGuard config.",
    )?;
    match decoded.len() {
        32 => Ok(()),
        other => Err(format!(
            "Decoded to {other} bytes, expected 32 — this is an account key rather than a WireGuard key."
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
