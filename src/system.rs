//! Host preflight checks: root access, Linux distribution and Docker.

use std::fs;
use std::io;
use std::process::{Command, Stdio};

/// A Linux distribution churn knows how to install Docker on.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Distro {
    Ubuntu,
    Debian,
    Fedora,
    Arch,
    Unsupported(String),
}

/// One command in a distro's Docker installation recipe.
#[derive(Clone, Copy, Debug)]
pub struct InstallStep {
    pub description: &'static str,
    pub command: &'static str,
}

impl Distro {
    /// Detect the host distro from `/etc/os-release`.
    pub fn from_host() -> Self {
        match fs::read_to_string("/etc/os-release") {
            Ok(contents) => detect_distro(&contents),
            Err(_) => Distro::Unsupported("unknown Linux".to_string()),
        }
    }

    pub fn display_name(&self) -> String {
        match self {
            Distro::Ubuntu => "Ubuntu".to_string(),
            Distro::Debian => "Debian".to_string(),
            Distro::Fedora => "Fedora".to_string(),
            Distro::Arch => "Arch Linux".to_string(),
            Distro::Unsupported(id) => format!("{id} (unsupported)"),
        }
    }

    /// Commands that install Docker Engine and the Compose plugin, or `None`
    /// when churn cannot install Docker on this distribution.
    pub fn install_steps(&self) -> Option<&'static [InstallStep]> {
        match self {
            Distro::Ubuntu => Some(UBUNTU_STEPS),
            Distro::Debian => Some(DEBIAN_STEPS),
            Distro::Fedora => Some(FEDORA_STEPS),
            Distro::Arch => Some(ARCH_STEPS),
            Distro::Unsupported(_) => None,
        }
    }
}

/// Parse `/etc/os-release` and map it onto a supported distro family.
///
/// `ID` is checked first, then the tokens in `ID_LIKE`, so Ubuntu derivatives
/// (Mint, Pop!_OS) resolve to Ubuntu and Arch derivatives resolve to Arch.
pub fn detect_distro(os_release: &str) -> Distro {
    let id = os_release_field(os_release, "ID")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let id_like = os_release_field(os_release, "ID_LIKE")
        .unwrap_or_default()
        .to_ascii_lowercase();
    let tokens = std::iter::once(id.as_str()).chain(id_like.split_whitespace());

    for token in tokens {
        match token {
            "ubuntu" => return Distro::Ubuntu,
            "debian" => return Distro::Debian,
            "fedora" => return Distro::Fedora,
            "arch" | "archlinux" => return Distro::Arch,
            _ => {}
        }
    }

    Distro::Unsupported(if id.is_empty() {
        "unknown Linux".to_string()
    } else {
        id
    })
}

fn os_release_field(contents: &str, key: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (found, value) = line.split_once('=')?;
        if found.trim() != key {
            return None;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
            .or_else(|| {
                value
                    .strip_prefix('\'')
                    .and_then(|value| value.strip_suffix('\''))
            })
            .unwrap_or(value);
        Some(value.to_string())
    })
}

/// True when the process has an effective/real uid of 0.
pub fn is_root() -> bool {
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| parse_uid(&status))
        .is_some_and(|uid| uid == 0)
}

/// Read the real uid from `/proc/<pid>/status`, split out for testing.
pub fn parse_uid(status: &str) -> Option<u32> {
    status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .and_then(|line| line["Uid:".len()..].split_whitespace().next())
        .and_then(|uid| uid.parse().ok())
}

/// True when `docker` and the Compose v2 plugin are both usable.
pub fn docker_ready() -> bool {
    which("docker") && command_succeeds("docker", &["compose", "version"])
}

pub fn which(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

fn command_succeeds(program: &str, args: &[&str]) -> bool {
    Command::new(program)
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Run one installation step through `sh`, reporting stderr on failure.
pub fn run_step(step: &InstallStep) -> io::Result<()> {
    let output = Command::new("sh").arg("-c").arg(step.command).output()?;
    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut detail = String::new();
    if !stdout.trim().is_empty() {
        detail.push_str(stdout.trim_end());
    }
    if !stderr.trim().is_empty() {
        if !detail.is_empty() {
            detail.push('\n');
        }
        detail.push_str(stderr.trim_end());
    }

    Err(io::Error::other(format!(
        "command failed ({}): {}\n{}",
        output.status,
        step.command,
        detail.trim_end()
    )))
}

const UBUNTU_STEPS: &[InstallStep] = &[
    InstallStep {
        description: "updating package lists",
        command: "apt-get update",
    },
    InstallStep {
        description: "installing prerequisites",
        command: "apt-get install -y ca-certificates curl",
    },
    InstallStep {
        description: "adding the Docker signing key",
        command: "install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc",
    },
    InstallStep {
        description: "adding the Docker apt repository",
        command: r#"echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" > /etc/apt/sources.list.d/docker.list"#,
    },
    InstallStep {
        description: "updating package lists",
        command: "apt-get update",
    },
    InstallStep {
        description: "installing Docker Engine and Compose",
        command: "DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    },
    InstallStep {
        description: "enabling the Docker service",
        command: "systemctl enable --now docker",
    },
];

const DEBIAN_STEPS: &[InstallStep] = &[
    InstallStep {
        description: "updating package lists",
        command: "apt-get update",
    },
    InstallStep {
        description: "installing prerequisites",
        command: "apt-get install -y ca-certificates curl",
    },
    InstallStep {
        description: "adding the Docker signing key",
        command: "install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && chmod a+r /etc/apt/keyrings/docker.asc",
    },
    InstallStep {
        description: "adding the Docker apt repository",
        command: r#"echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list"#,
    },
    InstallStep {
        description: "updating package lists",
        command: "apt-get update",
    },
    InstallStep {
        description: "installing Docker Engine and Compose",
        command: "DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    },
    InstallStep {
        description: "enabling the Docker service",
        command: "systemctl enable --now docker",
    },
];

const FEDORA_STEPS: &[InstallStep] = &[
    InstallStep {
        description: "installing dnf plugins",
        command: "dnf -y install dnf-plugins-core",
    },
    InstallStep {
        description: "adding the Docker repository",
        command: "dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo || dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo",
    },
    InstallStep {
        description: "installing Docker Engine and Compose",
        command: "dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
    },
    InstallStep {
        description: "enabling the Docker service",
        command: "systemctl enable --now docker",
    },
];

const ARCH_STEPS: &[InstallStep] = &[
    InstallStep {
        description: "installing Docker and Compose",
        command: "pacman -Syu --noconfirm docker docker-compose",
    },
    InstallStep {
        description: "enabling the Docker service",
        command: "systemctl enable --now docker",
    },
];
