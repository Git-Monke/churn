//! Which questions each stack needs and what it writes.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use crate::envfile;
use crate::question::{Question, Section};

pub type Answers = HashMap<Question, String>;

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
            Stack::Server => "Jellyfin media server",
            Stack::Torrent => "qBittorrent + Prowlarr behind a Mullvad WireGuard tunnel",
        }
    }

    pub fn questions(self) -> &'static [Question] {
        match self {
            Stack::Server => &[Question::DataDir],
            Stack::Torrent => &[
                Question::WireguardPrivateKey,
                Question::WireguardAddresses,
                Question::ServerCountries,
                Question::DataDir,
            ],
        }
    }

    pub fn dir(self) -> PathBuf {
        envfile::root().join(self.key())
    }

    pub fn env_path(self) -> PathBuf {
        self.dir().join(".env")
    }

    pub fn next_steps(self) -> &'static [&'static str] {
        match self {
            Stack::Server => &["open http://<vm-ip>:8096"],
            Stack::Torrent => &[
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
                "/dev/net/tun is missing — gluetun needs TUN; enable it in the host/VM kernel".to_string(),
            );
        }
        findings
    }

    /// Values from a previous run, so reruns can prefill the prompts.
    pub fn stored_answers(self) -> Answers {
        let env = envfile::read(&self.env_path());
        self.questions()
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
                Question::WireguardPrivateKey,
                Question::WireguardAddresses,
                Question::ServerCountries,
            ] {
                if let Some(value) = answers.get(&question) {
                    managed.push((question.env_key(), value.clone()));
                }
            }
        }

        let path = self.env_path();
        envfile::write_merged(&path, &managed)?;
        Ok(path)
    }
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
