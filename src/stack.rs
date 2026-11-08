//! Which questions each stack needs and what it writes.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::envfile::{self, EnvMap};
use crate::ports::{self, Port};
use crate::question::{Question, Section};
use crate::security;

pub type Answers = HashMap<Question, String>;

/// Registry image for the web dashboard. CI publishes a tag matching the
/// installer's package version; an explicit `CHURN_DASHBOARD_IMAGE` wins so a
/// locally built image can be used during development.
pub const DASHBOARD_IMAGE_REPO: &str = "ghcr.io/git-monke/churn-dashboard";
pub const DASHBOARD_IMAGE_ENV: &str = "CHURN_DASHBOARD_IMAGE";
/// Compose service name, used when the installer recreates it after Jellyfin
/// setup writes the API key.
pub const DASHBOARD_SERVICE: &str = "dashboard";

/// Fallback Mullvad location written to `SERVER_COUNTRIES` when the selected
/// config does not identify a known country.
///
/// Country selection is intentionally not a prompt: churn derives the exit
/// country from the Mullvad config filename (`us-atl-wg-001.conf` -> `USA`).
/// Set `SERVER_COUNTRIES` in `torrent/.env` to override it.
pub const FALLBACK_SERVER_COUNTRIES: &str = "Netherlands";

/// The value older churn releases wrote regardless of the selected config.
/// Reruns treat it as generated state so they can adopt the config's country.
const LEGACY_SERVER_COUNTRIES: &str = "Netherlands";

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
            Stack::Torrent => {
                "qBittorrent + Prowlarr + FlareSolverr behind a Mullvad WireGuard tunnel"
            }
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
                Question::WireguardArchive,
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
                let compose = self.dir().join("docker-compose.yml");
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
            managed.push(("VPN_SERVICE_PROVIDER", "mullvad".to_string()));
            managed.push(("VPN_TYPE", "wireguard".to_string()));
            for question in [
                Question::WireguardArchive,
                Question::WireguardConfig,
                Question::WireguardPrivateKey,
                Question::WireguardAddresses,
            ] {
                if let Some(value) = answers.get(&question) {
                    managed.push((question.env_key(), value.clone()));
                }
            }
            // No country prompt for now: keep a hand-edited choice, else use
            // the country encoded in the selected Mullvad config filename.
            let config_entry = answers
                .get(&Question::WireguardConfig)
                .or_else(|| stored_env.get("WIREGUARD_CONFIG"));
            let countries = server_countries(
                stored_env.get("SERVER_COUNTRIES").map(String::as_str),
                config_entry.map(String::as_str),
            );
            managed.push(("SERVER_COUNTRIES", countries));
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

    pub fn apply(self, answers: &Answers) -> io::Result<PathBuf> {
        let path = self.env_path();
        envfile::write_merged(&path, &self.managed_env(answers))?;
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

fn server_countries(existing: Option<&str>, config_entry: Option<&str>) -> String {
    let existing = existing.map(str::trim).filter(|value| !value.is_empty());
    // `Netherlands` was hardcoded by older releases; migrate it instead of
    // preserving the bug on rerun. Any other value is an explicit override.
    if let Some(value) = existing.filter(|value| *value != LEGACY_SERVER_COUNTRIES) {
        return value.to_string();
    }
    config_entry
        .and_then(crate::mullvad::country_for_entry)
        .map(str::to_string)
        .or_else(|| existing.map(str::to_string))
        .unwrap_or_else(|| FALLBACK_SERVER_COUNTRIES.to_string())
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

    #[test]
    fn server_country_comes_from_the_selected_config() {
        assert_eq!(server_countries(None, Some("us-atl-wg-001.conf")), "USA");
        assert_eq!(
            server_countries(Some(""), Some("se-sto-wg-002.conf")),
            "Sweden"
        );
    }

    #[test]
    fn explicit_country_overrides_the_config_and_legacy_default_is_migrated() {
        assert_eq!(
            server_countries(Some("Switzerland"), Some("us-atl-wg-001.conf")),
            "Switzerland"
        );
        assert_eq!(
            server_countries(Some(LEGACY_SERVER_COUNTRIES), Some("us-atl-wg-001.conf")),
            "USA"
        );
    }

    #[test]
    fn unknown_config_falls_back_to_existing_or_default() {
        assert_eq!(
            server_countries(None, Some("readme.conf")),
            FALLBACK_SERVER_COUNTRIES
        );
        assert_eq!(
            server_countries(Some(LEGACY_SERVER_COUNTRIES), None),
            LEGACY_SERVER_COUNTRIES
        );
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
