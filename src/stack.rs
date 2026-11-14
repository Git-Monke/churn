//! Which questions each stack needs and what it writes.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::envfile::{self, EnvMap};
use crate::ports::{self, Port};
use crate::question::{Question, Section};
use crate::security;
use crate::vpn::VpnProvider;

pub type Answers = HashMap<Question, String>;

/// Registry image for the web dashboard. CI publishes a tag matching the
/// installer's package version; an explicit `CHURN_DASHBOARD_IMAGE` wins so a
/// locally built image can be used during development.
pub const DASHBOARD_IMAGE_REPO: &str = "ghcr.io/git-monke/churn-dashboard";
pub const DASHBOARD_IMAGE_ENV: &str = "CHURN_DASHBOARD_IMAGE";
/// Compose service name, used when the installer recreates it after Jellyfin
/// setup writes the API key.
pub const DASHBOARD_SERVICE: &str = "dashboard";

/// Location written when neither a stored choice nor the provider default is
/// usable. Every provider's embedded list contains it except PIA, whose list is
/// region-shaped, so [`VpnProvider::default_location`] is consulted first.
pub const FALLBACK_VPN_LOCATION: &str = "Netherlands";

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Stack {
    Server,
    Torrent,
}

impl Stack {
    pub const ALL: [Stack; 2] = [Stack::Server, Stack::Torrent];

    pub fn key(self) -> &'static str {
        match self {
            Stack::Server => "server",
            Stack::Torrent => "torrent",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            Stack::Server => "Jellyfin + Sonarr + Radarr media server",
            Stack::Torrent => "qBittorrent + Prowlarr + FlareSolverr behind a Gluetun VPN tunnel",
        }
    }

    pub fn questions(self) -> &'static [Question] {
        match self {
            Stack::Server => &[
                Question::DownloadDir,
                Question::MediaDir,
                Question::Port(Port::Jellyfin),
                Question::Port(Port::Sonarr),
                Question::Port(Port::Radarr),
                Question::Port(Port::Dashboard),
            ],
            Stack::Torrent => &[
                Question::VpnProvider,
                Question::WireguardPrivateKey,
                Question::WireguardAddresses,
                Question::OpenvpnUser,
                Question::OpenvpnPassword,
                Question::VpnLocation,
                Question::DownloadDir,
                Question::MediaDir,
                Question::Port(Port::Qbittorrent),
                Question::Port(Port::Prowlarr),
                Question::Port(Port::VpnStatus),
            ],
        }
    }

    pub fn dir(self) -> PathBuf {
        envfile::root().join(self.key())
    }

    /// The other stack, used when sharing generated values such as host ports.
    pub fn other(self) -> Stack {
        match self {
            Stack::Server => Stack::Torrent,
            Stack::Torrent => Stack::Server,
        }
    }

    pub fn env_path(self) -> PathBuf {
        self.dir().join(".env")
    }

    /// Grant the containers' group read access to this stack's `.env`.
    ///
    /// Only the server file is mounted into a container (the dashboard runs as
    /// `PUID:PGID`), but it stays owned by root so compose interpolation cannot
    /// be steered by an unprivileged user. The torrent file holds the WireGuard
    /// private key and stays owner-only.
    pub fn share_env(self) -> io::Result<()> {
        if self != Stack::Server {
            return Ok(());
        }
        let path = self.env_path();
        let gid = envfile::read(&path)
            .get("PGID")
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(1000);
        envfile::share(&path, gid)
    }

    /// The compose file this stack is started and removed with.
    pub fn compose_path(self) -> PathBuf {
        self.dir().join("docker-compose.yml")
    }

    /// Whether this stack was ever installed under `root`.
    ///
    /// Uninstall uses this to skip a stack that was never set up: `docker
    /// compose down` in a missing directory fails in `Command::spawn` with a
    /// bare `ENOENT`, which reads as a churn fault rather than "nothing to do".
    pub fn is_installed_in(self, root: &Path) -> bool {
        root.join(self.key()).join("docker-compose.yml").is_file()
    }

    pub fn is_installed(self) -> bool {
        self.is_installed_in(&envfile::root())
    }

    /// Generated state that an uninstall removes.
    ///
    /// These are only app configuration, caches and the generated `.env`; the
    /// media and download directories are never included.
    pub fn state_paths(self) -> Vec<PathBuf> {
        let dir = self.dir();
        match self {
            Stack::Server => vec![dir.join("config"), dir.join("cache"), self.env_path()],
            Stack::Torrent => vec![dir.join("config"), self.env_path()],
        }
    }

    /// Host directories the stack's bind mounts write into, relative to the
    /// stack root.
    ///
    /// These are the app config/cache trees each container owns, not the media
    /// tree: they hold only generated service state, so churn may create them
    /// and hand them to `PUID:PGID`. Kept in sync with the `./config`/`./cache`
    /// bind mounts in the compose files, and covered by a test that renders
    /// both files so a new mount cannot be added without a directory here.
    pub fn config_dirs(self) -> &'static [&'static str] {
        match self {
            Stack::Server => &[
                "config/jellyfin",
                "config/sonarr",
                "config/radarr",
                "cache/jellyfin",
            ],
            Stack::Torrent => &["config/qbittorrent", "config/prowlarr"],
        }
    }

    pub fn next_steps(self, answers: &Answers) -> Vec<String> {
        match self {
            Stack::Server => vec![
                format!(
                    "open http://<vm-ip>:{}  # churn dashboard",
                    answer_port(answers, Port::Dashboard)
                ),
                format!(
                    "open http://<vm-ip>:{}  # Jellyfin (use the admin account churn created)",
                    answer_port(answers, Port::Jellyfin)
                ),
                format!(
                    "open http://<vm-ip>:{}  # Sonarr",
                    answer_port(answers, Port::Sonarr)
                ),
                format!(
                    "open http://<vm-ip>:{}  # Radarr",
                    answer_port(answers, Port::Radarr)
                ),
            ],
            Stack::Torrent => {
                let compose = self.compose_path();
                vec![
                    format!(
                        "docker compose -f '{}' logs vpn-check    # confirms torrent egress is VPN-only",
                        compose.display()
                    ),
                    format!(
                        "docker compose -f '{}' logs qbittorrent   # temporary admin password",
                        compose.display()
                    ),
                    format!(
                        "open http://<vm-ip>:{}  # qBittorrent",
                        answer_port(answers, Port::Qbittorrent)
                    ),
                    format!(
                        "open http://<vm-ip>:{}  # Prowlarr (qBittorrent is wired up for you)",
                        answer_port(answers, Port::Prowlarr)
                    ),
                ]
            }
        }
    }

    /// Non-fatal host checks reported before anything is written.
    pub fn preflight(self) -> Vec<String> {
        let mut findings = Vec::new();
        if self == Stack::Torrent && !Path::new("/dev/net/tun").exists() {
            findings.push(
                "/dev/net/tun is missing — gluetun needs TUN; enable it in the host/VM kernel"
                    .to_string(),
            );
        }
        if self == Stack::Torrent {
            let detected = envfile::host_ip();
            let stored = envfile::read(&self.env_path());
            let configured = if detected.starts_with("127.") {
                stored.get("HOST_IP").map(String::as_str).unwrap_or("")
            } else {
                &detected
            };
            if configured.is_empty() {
                findings.push(
                    "could not detect a LAN IP — Prowlarr cannot reach Sonarr/Radarr; set HOST_IP in torrent/.env"
                        .to_string(),
                );
            } else if !security::is_local_ipv4(configured) {
                findings.push(format!(
                    "HOST_IP={configured} is not a loopback/LAN address — the torrent stack will refuse to start, because that address is the only non-VPN firewall exception"
                ));
            }
        }
        findings
    }

    /// Values from a previous run, so reruns can prefill the prompts.
    pub fn stored_answers(self) -> Answers {
        let env = envfile::read(&self.env_path());
        Question::ALL
            .iter()
            .filter_map(|question| {
                let value = if matches!(question, Question::DownloadDir | Question::MediaDir) {
                    envfile::storage_path(&env, question.env_key())
                } else {
                    env.get(question.env_key()).cloned()
                };
                value.map(|value| (*question, value))
            })
            .collect()
    }

    /// The `.env` keys this stack manages, in write order.
    ///
    /// Pure, so tests can assert the values without touching the filesystem.
    /// The storage pair is written as resolved paths: `MEDIA_DIR` never depends
    /// on `${DOWNLOAD_DIR}` expansion, so the file stays readable on its own.
    pub fn managed_env(self, answers: &Answers) -> Vec<(&'static str, String)> {
        // Write every host port to both stacks: the dashboard and prowlarr-init
        // need ports owned by the other stack. Stored values survive reruns.
        let mut stored_env = envfile::read(&self.other().env_path());
        stored_env.extend(envfile::read(&self.env_path()));
        self.managed_env_with(answers, &stored_env)
    }

    /// [`Self::managed_env`] with the stored `.env` supplied by the caller.
    ///
    /// `stored_env` is only consulted for values the user cannot answer from
    /// scratch (hand-edited ports, a country override). Taking it as a parameter
    /// keeps the function testable without a root directory on disk.
    pub fn managed_env_with(
        self,
        answers: &Answers,
        stored_env: &EnvMap,
    ) -> Vec<(&'static str, String)> {
        let download_dir = download_dir(answers);
        let media_dir = media_dir(answers);
        let (uid, gid) = stack_owner(Path::new(&media_dir), Path::new(&download_dir));

        let mut managed: Vec<(&'static str, String)> = vec![
            ("DOWNLOAD_DIR", download_dir),
            ("MEDIA_DIR", media_dir),
            ("PUID", uid.to_string()),
            ("PGID", gid.to_string()),
            ("TZ", envfile::timezone()),
        ];
        for port in Port::ALL {
            let value = answers
                .get(&Question::Port(port))
                .filter(|value| ports::validate_port(value).is_ok())
                .cloned()
                .or_else(|| {
                    stored_env
                        .get(port.env_key())
                        .filter(|value| ports::validate_port(value).is_ok())
                        .cloned()
                })
                .unwrap_or_else(|| port.default_port().to_string());
            managed.push((port.env_key(), value));
        }

        if self == Stack::Server {
            managed.push((DASHBOARD_IMAGE_ENV, dashboard_image()));
        }

        if self == Stack::Torrent {
            let provider = answer_provider(answers, stored_env);
            managed.push(("VPN_SERVICE_PROVIDER", provider.gluetun_id().to_string()));
            managed.push(("VPN_TYPE", provider.protocol().as_env().to_string()));
            // Only the keys this provider's protocol actually reads, so a
            // provider switch never leaves a stale credential of the wrong
            // type behind in the file.
            for question in [
                Question::WireguardPrivateKey,
                Question::WireguardAddresses,
                Question::OpenvpnUser,
                Question::OpenvpnPassword,
            ] {
                if !question.applies_to(provider) {
                    continue;
                }
                let value = answers
                    .get(&question)
                    .cloned()
                    .or_else(|| stored_env.get(question.env_key()).cloned())
                    .unwrap_or_default();
                managed.push((question.env_key(), value));
            }
            // Written twice on purpose: `VPN_LOCATION` is the provider-neutral
            // key churn reads back on a rerun, and the provider's own key is
            // what Gluetun actually parses. Both hold the same value, so a
            // hand-edit of either is visible in the file.
            let location = vpn_location(answers, stored_env, provider);
            managed.push(("VPN_LOCATION", location.clone()));
            managed.push((provider.location_key(), location));
            // Prowlarr and Sonarr/Radarr live in different network namespaces;
            // both reach each other through this address (same-machine setups).
            // When detection fails, keep a hand-edited HOST_IP from .env.
            let host_ip = envfile::host_ip();
            if !host_ip.starts_with("127.") {
                managed.push(("HOST_IP", host_ip));
            }
        }

        managed
    }

    /// `.env` keys that must not survive this run.
    ///
    /// The generic writer preserves unrelated keys, which is right for
    /// hand-added settings and wrong for state churn itself used to own: the
    /// other protocol's credentials after a provider switch, and the archive
    /// keys that predate typed credentials.
    pub fn dropped_env(self, answers: &Answers) -> Vec<&'static str> {
        if self != Stack::Torrent {
            return Vec::new();
        }
        let mut stored_env = envfile::read(&self.other().env_path());
        stored_env.extend(envfile::read(&self.env_path()));
        let provider = answer_provider(answers, &stored_env);
        let mut dropped = crate::vpn::stale_credential_keys(provider);
        dropped.extend(crate::vpn::stale_location_keys(provider));
        dropped.extend(["WIREGUARD_ARCHIVE", "WIREGUARD_CONFIG"]);
        dropped
    }

    pub fn apply(self, answers: &Answers) -> io::Result<PathBuf> {
        let path = self.env_path();
        envfile::write_merged_dropping(
            &path,
            &self.managed_env(answers),
            &self.dropped_env(answers),
        )?;
        self.share_env()?;
        Ok(path)
    }
}

/// Sort chosen stacks into [`Stack::ALL`] order.
///
/// `server` must start before `torrent`: prowlarr-init reads the Sonarr/Radarr
/// API keys that the server stack writes during startup.
pub fn start_order(mut chosen: Vec<Stack>) -> Vec<Stack> {
    chosen.sort_by_key(|stack| Stack::ALL.iter().position(|known| known == stack));
    chosen
}

/// Default media directory: a `media` folder inside the download directory.
///
/// This reproduces today's single-`DATA_DIR` layout exactly, so the split is
/// only a naming change until the user points `MEDIA_DIR` somewhere else.
pub const MEDIA_SUBDIR: &str = "media";

pub fn download_dir(answers: &Answers) -> String {
    answers
        .get(&Question::DownloadDir)
        .map(|value| crate::question::normalize_path(value))
        .unwrap_or_else(|| "/data".to_string())
}

pub fn media_dir(answers: &Answers) -> String {
    answers
        .get(&Question::MediaDir)
        .map(|value| crate::question::normalize_path(value))
        .unwrap_or_else(|| format!("{}/{MEDIA_SUBDIR}", download_dir(answers)))
}

/// The `PUID:PGID` a stack's containers run as, read back from its `.env`.
///
/// Used by `churn update`, which heals an existing install without the
/// interactive storage answers that produced the file. Falls back to 1000 (the
/// compose default) when a key is missing or malformed.
pub fn env_owner(stack: Stack) -> (u32, u32) {
    let env = envfile::read(&stack.env_path());
    let id = |key: &str| {
        env.get(key)
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(1000)
    };
    (id("PUID"), id("PGID"))
}

/// Create the app config/cache directories a stack's containers write into, and
/// hand each one to the stack's `PUID:PGID`.
///
/// Docker creates a missing bind-mount source as `root:root 0755`, so a
/// container running as `PUID:PGID` cannot populate it — Jellyfin dies trying
/// to `mkdir /config/log`, and so would Sonarr/Radarr. Running before
/// `compose up` avoids that: the directory already exists and is owned by the
/// identity the container runs as.
///
/// A directory churn creates here, or one that already exists but is owned by
/// root (what Docker's bind-mount auto-create leaves behind, including after a
/// first start that failed for this very reason), is chowned to `owner`. A
/// directory already owned by a non-root identity is left untouched, so an
/// adopted config keeps its owner — the same rule the media tree follows.
/// Returns the directories that were handed over.
pub fn prepare_config_dirs(
    base: &Path,
    stack: Stack,
    owner: (u32, u32),
) -> io::Result<Vec<PathBuf>> {
    let mut prepared = Vec::new();
    for relative in stack.config_dirs() {
        let path = base.join(stack.key()).join(relative);
        let created = !path.exists();
        if created {
            std::fs::create_dir_all(&path)?;
        }
        // Docker creates a missing source as root:root; adopt exactly those,
        // and anything churn just created (which is root-owned too, as churn
        // runs as root).
        if !created && envfile::owner(&path).0 != 0 {
            continue;
        }
        match envfile::chown(&path, owner.0, owner.1) {
            Ok(()) => prepared.push(path),
            Err(err) if created => {
                return Err(io::Error::new(
                    err.kind(),
                    format!(
                        "could not give {} to {}:{}: {err}",
                        path.display(),
                        owner.0,
                        owner.1
                    ),
                ));
            }
            // A pre-existing root-owned directory we could not adopt stays in
            // place; the container may still write it (for example it is
            // already group-writable), so this is not fatal.
            Err(_) => {}
        }
    }
    Ok(prepared)
}

/// Owning uid/gid for the containers.
///
/// Sonarr/Radarr import into the media root, so its owner is the better source;
/// otherwise use the download directory, which qBittorrent writes. A root-owned
/// media tree is skipped rather than adopted: running the whole stack as uid 0
/// because `/mnt/media` happens to be root-owned is never what the user wants,
/// so the warning from [`storage_warning`] is the honest outcome.
pub fn stack_owner(media: &Path, download: &Path) -> (u32, u32) {
    if media.exists() {
        let (uid, gid) = envfile::owner(media);
        if uid != 0 {
            return (uid, gid);
        }
    }
    envfile::owner(download)
}

/// Warn when the resolved containers could not write to the media directory.
///
/// Reported before anything is written; the installer never changes ownership
/// of an existing library, so an unwritable library must be visible up front
/// instead of surfacing later as silent import failures.
pub fn storage_warning(media: &Path, owner: (u32, u32)) -> Option<String> {
    let metadata = std::fs::metadata(media).ok()?;
    if !metadata.is_dir() {
        return Some(format!(
            "{} exists but is not a directory.",
            media.display()
        ));
    }
    if is_root() {
        return None;
    }
    let (uid, _) = envfile::owner(media);
    if uid == owner.0 {
        return None;
    }
    Some(format!(
        "{} is owned by uid {uid} but the containers will run as PUID {}.\n\
         Sonarr, Radarr and Jellyfin may not be able to write there.\n\
         churn does not change ownership of an existing library; fix it yourself if imports fail.",
        media.display(),
        owner.0
    ))
}

fn is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

fn answer_port(answers: &Answers, port: Port) -> u16 {
    answers
        .get(&Question::Port(port))
        .and_then(|value| ports::validate_port(value).ok())
        .unwrap_or_else(|| port.default_port())
}

fn dashboard_image() -> String {
    dashboard_image_from(std::env::var(DASHBOARD_IMAGE_ENV).ok())
}

fn dashboard_image_from(override_image: Option<String>) -> String {
    override_image
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{DASHBOARD_IMAGE_REPO}:{}", env!("CARGO_PKG_VERSION")))
}

/// The provider an install is configured for.
///
/// The answer wins; otherwise the value a previous run wrote is read back so a
/// rerun keeps the provider the user originally chose. `VPN_SERVICE_PROVIDER`
/// is Gluetun's own key, so it is also what a hand-edited `.env` uses.
fn answer_provider(answers: &Answers, stored_env: &EnvMap) -> VpnProvider {
    answers
        .get(&Question::VpnProvider)
        .map(String::as_str)
        .or_else(|| stored_env.get("VPN_SERVICE_PROVIDER").map(String::as_str))
        .and_then(VpnProvider::from_gluetun_id)
        .unwrap_or(VpnProvider::DEFAULT)
}

/// The location written as both `VPN_LOCATION` and the provider's filter key.
///
/// A stored value that the provider does not know is discarded rather than
/// written: Gluetun would silently pick a server in some other country, which
/// is worse than an obviously default choice.
fn vpn_location(answers: &Answers, stored_env: &EnvMap, provider: VpnProvider) -> String {
    let candidates = [
        answers.get(&Question::VpnLocation).map(String::as_str),
        stored_env.get("VPN_LOCATION").map(String::as_str),
        stored_env.get(provider.location_key()).map(String::as_str),
    ];
    candidates
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty() && provider.validate_location(value).is_ok())
        .unwrap_or_else(|| provider.default_location().unwrap_or(FALLBACK_VPN_LOCATION))
        .to_string()
}

/// Every unique question across the chosen stacks, VPN before Storage.
///
/// This is where the orchestration dedupes: picking both `server` and `torrent`
/// yields one `DownloadDir` and one `MediaDir` question, not two of each.
pub fn collect_questions(chosen: &[Stack]) -> Vec<Question> {
    let mut ordered: Vec<Question> = Vec::new();
    for section in Section::ORDER {
        for stack in chosen {
            for question in stack.questions() {
                if question.section() == section && !ordered.contains(question) {
                    ordered.push(*question);
                }
            }
        }
    }
    ordered
}

/// Answers usable in a summary table: secrets are masked.
pub fn summary(question: Question, answers: &Answers) -> Option<String> {
    let value = answers.get(&question)?;
    Some(if question.is_secret() {
        crate::question::mask(value)
    } else {
        value.clone()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_image_defaults_to_the_release_and_honors_an_override() {
        let release = format!("{DASHBOARD_IMAGE_REPO}:{}", env!("CARGO_PKG_VERSION"));
        assert_eq!(dashboard_image_from(None), release);
        assert_eq!(dashboard_image_from(Some("  ".to_string())), release);
        assert_eq!(
            dashboard_image_from(Some(" churn-dashboard:dev ".to_string())),
            "churn-dashboard:dev"
        );
    }

    #[test]
    fn server_starts_before_torrent() {
        assert_eq!(
            start_order(vec![Stack::Torrent, Stack::Server]),
            vec![Stack::Server, Stack::Torrent]
        );
    }

    fn answers_with(pairs: &[(Question, &str)]) -> Answers {
        pairs
            .iter()
            .map(|(question, value)| (*question, (*value).to_string()))
            .collect()
    }

    #[test]
    fn provider_answer_wins_and_stored_value_is_the_fallback() {
        let stored: EnvMap = [("VPN_SERVICE_PROVIDER".to_string(), "ivpn".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            answer_provider(
                &answers_with(&[(Question::VpnProvider, "nordvpn")]),
                &stored
            ),
            VpnProvider::NordVpn
        );
        assert_eq!(answer_provider(&Answers::new(), &stored), VpnProvider::Ivpn);
        // An unknown or hand-mangled value must not become a bogus provider.
        let junk: EnvMap = [("VPN_SERVICE_PROVIDER".to_string(), "nope".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            answer_provider(&Answers::new(), &junk),
            VpnProvider::DEFAULT
        );
    }

    #[test]
    fn location_prefers_the_answer_then_the_provider_key() {
        let stored: EnvMap = [("SERVER_COUNTRIES".to_string(), "Sweden".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            vpn_location(
                &answers_with(&[(Question::VpnLocation, "Norway")]),
                &stored,
                VpnProvider::Mullvad
            ),
            "Norway"
        );
        assert_eq!(
            vpn_location(&Answers::new(), &stored, VpnProvider::Mullvad),
            "Sweden"
        );
    }

    #[test]
    fn location_unknown_to_the_provider_falls_back_to_its_default() {
        // "US Seattle" is a PIA region; a Mullvad install must not write it.
        let stored: EnvMap = [("VPN_LOCATION".to_string(), "US Seattle".to_string())]
            .into_iter()
            .collect();
        assert_eq!(
            vpn_location(&Answers::new(), &stored, VpnProvider::Mullvad),
            VpnProvider::Mullvad.default_location().unwrap()
        );
        assert_eq!(
            vpn_location(&Answers::new(), &stored, VpnProvider::PrivateInternetAccess),
            "US Seattle"
        );
    }

    #[test]
    fn torrent_env_writes_one_protocol_and_both_location_keys() {
        let answers = answers_with(&[
            (Question::VpnProvider, "private internet access"),
            (Question::OpenvpnUser, "p1234567"),
            (Question::OpenvpnPassword, "hunter2"),
            (Question::VpnLocation, "US Seattle"),
            (
                Question::WireguardPrivateKey,
                "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=",
            ),
        ]);
        let env: HashMap<&str, String> = Stack::Torrent
            .managed_env_with(&answers, &EnvMap::new())
            .into_iter()
            .collect();

        assert_eq!(env["VPN_SERVICE_PROVIDER"], "private internet access");
        assert_eq!(env["VPN_TYPE"], "openvpn");
        assert_eq!(env["OPENVPN_USER"], "p1234567");
        assert_eq!(env["OPENVPN_PASSWORD"], "hunter2");
        assert_eq!(env["SERVER_REGIONS"], "US Seattle");
        assert_eq!(env["VPN_LOCATION"], "US Seattle");
        assert!(!env.contains_key("WIREGUARD_PRIVATE_KEY"));
        assert!(!env.contains_key("SERVER_COUNTRIES"));
    }

    #[test]
    fn torrent_env_omits_the_address_when_the_provider_needs_no_address() {
        let answers = answers_with(&[
            (Question::VpnProvider, "protonvpn"),
            (Question::VpnLocation, "Netherlands"),
        ]);
        let stored: EnvMap = [
            ("WIREGUARD_PRIVATE_KEY".to_string(), "abc".to_string()),
            (
                "WIREGUARD_ADDRESSES".to_string(),
                "10.64.0.2/32".to_string(),
            ),
        ]
        .into_iter()
        .collect();
        let env: HashMap<&str, String> = Stack::Torrent
            .managed_env_with(&answers, &stored)
            .into_iter()
            .collect();

        assert_eq!(env["VPN_TYPE"], "wireguard");
        assert_eq!(env["WIREGUARD_PRIVATE_KEY"], "abc");
        // ProtonVPN takes the key alone; writing a stale address would be a
        // leftover from whichever provider needed one before.
        assert!(!env.contains_key("WIREGUARD_ADDRESSES"));
        assert_eq!(env["SERVER_COUNTRIES"], "Netherlands");
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "churn-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn prepare_config_dirs_creates_and_owns_each_bind_mount_source() {
        let root = temp_root("config-dirs");
        let owner = envfile::owner(&root);

        let prepared = prepare_config_dirs(&root, Stack::Server, owner).unwrap();
        for relative in Stack::Server.config_dirs() {
            let path = root.join("server").join(relative);
            assert!(path.is_dir(), "{} should exist", path.display());
            assert_eq!(
                envfile::owner(&path),
                owner,
                "{} should be owned",
                path.display()
            );
        }
        assert_eq!(prepared.len(), Stack::Server.config_dirs().len());

        // Torrent's own set must land under torrent/ and never touch server/.
        prepare_config_dirs(&root, Stack::Torrent, owner).unwrap();
        for relative in Stack::Torrent.config_dirs() {
            assert!(root.join("torrent").join(relative).is_dir());
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_config_dirs_leaves_an_adopted_config_untouched() {
        let root = temp_root("config-adopted");
        let adopted = root.join("server/config/jellyfin");
        std::fs::create_dir_all(&adopted).unwrap();

        // The rule keys on a non-root owner. Running as non-root the fresh
        // directory already qualifies; as root it must be handed to some
        // non-root id first (churn running as root is the real install case).
        let here = envfile::owner(&root);
        let other = if here.0 == 0 { (1234, 1234) } else { here };
        if here.0 == 0 {
            envfile::chown(&adopted, other.0, other.1).unwrap();
        }

        let prepared = prepare_config_dirs(&root, Stack::Server, other).unwrap();
        assert!(
            !prepared.contains(&adopted),
            "a directory owned by a non-root identity must be left alone"
        );
        assert_eq!(envfile::owner(&adopted), other);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn env_owner_reads_puid_and_pgid_and_defaults_to_1000() {
        let root = temp_root("env-owner");
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("server/.env"), "PUID=1234\nPGID=5678\n").unwrap();
        std::fs::create_dir_all(root.join("torrent")).unwrap();
        std::fs::write(root.join("torrent/.env"), "DOWNLOAD_DIR=/data\n").unwrap();

        // The functions read from `envfile::root()`, so drive them through a
        // temporary CHURN_ROOT just like the installer does.
        // SAFETY: single-threaded test; the variable is restored below.
        unsafe { std::env::set_var("CHURN_ROOT", &root) };
        assert_eq!(env_owner(Stack::Server), (1234, 5678));
        assert_eq!(env_owner(Stack::Torrent), (1000, 1000));
        unsafe { std::env::remove_var("CHURN_ROOT") };

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stack_is_installed_only_once_its_compose_file_exists() {
        let root = std::env::temp_dir().join(format!("churn-installed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("torrent")).unwrap();

        assert!(!Stack::Server.is_installed_in(&root), "no directory at all");
        assert!(
            !Stack::Torrent.is_installed_in(&root),
            "directory but no compose file"
        );

        std::fs::write(root.join("torrent/docker-compose.yml"), "services: {}\n").unwrap();
        assert!(Stack::Torrent.is_installed_in(&root));
        assert!(!Stack::Server.is_installed_in(&root));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn uninstall_targets_only_generated_state() {
        let names = |stack: Stack| {
            stack
                .state_paths()
                .into_iter()
                .map(|path| path.strip_prefix(stack.dir()).unwrap().to_path_buf())
                .collect::<Vec<_>>()
        };

        assert_eq!(
            names(Stack::Server),
            vec![
                PathBuf::from("config"),
                PathBuf::from("cache"),
                PathBuf::from(".env")
            ]
        );
        assert_eq!(
            names(Stack::Torrent),
            vec![PathBuf::from("config"), PathBuf::from(".env")]
        );
    }
}
