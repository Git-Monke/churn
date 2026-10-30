//! Which questions each stack needs and what it writes.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::envfile;
use crate::question::{Question, Section};
use crate::security;

pub type Answers = HashMap<Question, String>;

/// Default Mullvad location written to `SERVER_COUNTRIES`.
///
/// Country selection is intentionally not a prompt right now; change the
/// value in `torrent/.env` (or this default) when that becomes configurable.
pub const DEFAULT_SERVER_COUNTRIES: &str = "Netherlands";

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
            Stack::Server => &[Question::DataDir],
            Stack::Torrent => &[Question::WireguardArchive, Question::DataDir],
        }
    }

    pub fn dir(self) -> PathBuf {
        envfile::root().join(self.key())
    }

    pub fn env_path(self) -> PathBuf {
        self.dir().join(".env")
    }

    /// Generated state that an uninstall removes.
    ///
    /// These are only app configuration, caches and the generated `.env`; the
    /// media/download directory (`DATA_DIR`) is never included.
    pub fn state_paths(self) -> Vec<PathBuf> {
        let dir = self.dir();
        match self {
            Stack::Server => vec![dir.join("config"), dir.join("cache"), self.env_path()],
            Stack::Torrent => vec![dir.join("config"), self.env_path()],
        }
    }

    pub fn next_steps(self) -> &'static [&'static str] {
        match self {
            Stack::Server => &[
                "open http://<vm-ip>:8096  # Jellyfin",
                "open http://<vm-ip>:8989  # Sonarr",
                "open http://<vm-ip>:7878  # Radarr",
            ],
            Stack::Torrent => &[
                "docker logs vpn-check    # confirms torrent egress is VPN-only",
                "docker logs qbittorrent   # temporary admin password",
                "open http://<vm-ip>:9696  # Prowlarr (qBittorrent is wired up for you)",
            ],
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
                env.get(question.env_key())
                    .map(|value| (*question, value.clone()))
            })
            .collect()
    }

    pub fn apply(self, answers: &Answers) -> io::Result<PathBuf> {
        let data_dir = answers
            .get(&Question::DataDir)
            .cloned()
            .unwrap_or_else(|| "/data".to_string());
        let (uid, gid) = envfile::owner(Path::new(&data_dir));

        let mut managed: Vec<(&str, String)> = vec![
            ("DATA_DIR", data_dir),
            ("PUID", uid.to_string()),
            ("PGID", gid.to_string()),
            ("TZ", envfile::timezone()),
        ];

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
            // No country prompt for now: keep a previous choice, else default.
            let countries = server_countries(
                envfile::read(&self.env_path())
                    .get("SERVER_COUNTRIES")
                    .map(String::as_str),
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

        let path = self.env_path();
        envfile::write_merged(&path, &managed)?;
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

fn server_countries(existing: Option<&str>) -> String {
    existing.unwrap_or(DEFAULT_SERVER_COUNTRIES).to_string()
}

/// Every unique question across the chosen stacks, VPN before Storage.
///
/// This is where the orchestration dedupes: picking both `server` and `torrent`
/// yields one `DataDir` question, not two.
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
    fn server_starts_before_torrent() {
        assert_eq!(
            start_order(vec![Stack::Torrent, Stack::Server]),
            vec![Stack::Server, Stack::Torrent]
        );
    }

    #[test]
    fn server_country_defaults_when_not_configured() {
        assert_eq!(server_countries(None), DEFAULT_SERVER_COUNTRIES);
        assert_eq!(server_countries(Some("Sweden")), "Sweden");
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
