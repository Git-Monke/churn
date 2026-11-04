//! Host preflight checks: root access, Linux distribution and Docker.

use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};

use crate::compose;
use crate::security;

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

/// Start the project in `dir` (detached), forwarding parsed Compose events to
/// `on_event` as they arrive.
///
/// JSON progress keeps each event's process id intact so the caller can keep a
/// single latest line per image, container, network or volume.
/// The tail of the output is retained so a failed run still reports what Docker
/// was doing.
pub fn compose_up(dir: &Path, on_event: &mut dyn FnMut(&str)) -> io::Result<()> {
    compose_run(dir, "up", &["up", "-d"], on_event)
}

/// Verify the effective Compose configuration keeps the torrent stack inside
/// Gluetun's network namespace and behind its kill switch.
pub fn verify_torrent_isolation(dir: &Path) -> io::Result<()> {
    let output = Command::new("docker")
        .args(["compose", "config", "--format", "json"])
        .current_dir(dir)
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "docker compose config failed in {}:\n{}",
            dir.display(),
            String::from_utf8_lossy(&output.stderr).trim_end()
        )));
    }

    let config = serde_json::from_slice(&output.stdout).map_err(|err| {
        io::Error::other(format!(
            "docker compose config in {} was not valid JSON: {err}",
            dir.display()
        ))
    })?;
    security::verify_torrent_isolation(&config).map_err(|problems| {
        io::Error::other(format!(
            "refusing to start the torrent stack because its VPN isolation is unsafe:\n  - {}",
            problems.join("\n  - ")
        ))
    })
}

/// Recreate one service so it picks up values written after `compose up`
/// (for the dashboard, the Jellyfin API key in `server/.env`).
pub fn compose_recreate_service(
    dir: &Path,
    service: &str,
    on_event: &mut dyn FnMut(&str),
) -> io::Result<()> {
    compose_run(
        dir,
        "up",
        &["up", "-d", "--no-deps", "--force-recreate", service],
        on_event,
    )
}

/// Stop and remove the project's containers, networks and named volumes.
///
/// Both stacks only declare bind mounts for media/config; the server stack's
/// `churn-cache` is the disposable dashboard search cache.
pub fn compose_down(dir: &Path, on_event: &mut dyn FnMut(&str)) -> io::Result<()> {
    compose_run(
        dir,
        "down",
        &["down", "--remove-orphans", "--volumes"],
        on_event,
    )
}

fn compose_run(
    dir: &Path,
    action: &str,
    args: &[&str],
    on_event: &mut dyn FnMut(&str),
) -> io::Result<()> {
    let mut command = Command::new("docker");
    command
        .args(["compose", "--ansi", "never", "--progress", "json"])
        .args(args)
        .current_dir(dir);

    let output = run_streaming(command, on_event)?;
    if output.status.success() {
        return Ok(());
    }

    let detail = output
        .tail
        .iter()
        .map(|line| compose::describe(line))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let mut message = format!(
        "docker compose {action} failed in {} ({})",
        dir.display(),
        output.status
    );
    if !detail.is_empty() {
        message.push('\n');
        message.push_str(&detail);
    }
    Err(io::Error::other(message))
}

/// How many normalised output lines to retain for error reporting.
const TAIL_LIMIT: usize = 200;

struct StreamedCommand {
    status: ExitStatus,
    tail: Vec<String>,
}

/// Run `command` with piped stdout/stderr, emitting each line as it appears.
///
/// Both pipes are drained on their own threads so a chatty stderr cannot block
/// stdout (or vice versa). Lines are reassembled on the calling thread, which
/// keeps the callback single-threaded and in a stable order.
fn run_streaming(
    mut command: Command,
    on_line: &mut dyn FnMut(&str),
) -> io::Result<StreamedCommand> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("failed to capture docker stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("failed to capture docker stderr"))?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let stdout_reader = spawn_reader(stdout, tx.clone());
    let stderr_reader = spawn_reader(stderr, tx);

    let mut assembler = LineAssembler::default();
    for chunk in rx {
        assembler.push(&chunk, on_line);
    }
    assembler.finish(on_line);

    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    let status = child.wait()?;

    Ok(StreamedCommand {
        status,
        tail: assembler.tail.into_iter().collect(),
    })
}

fn spawn_reader<R>(mut reader: R, tx: mpsc::Sender<Vec<u8>>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    if tx.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    })
}

#[derive(Default)]
struct LineAssembler {
    pending: Vec<u8>,
    tail: VecDeque<String>,
}

impl LineAssembler {
    /// Feed a chunk, emitting every complete `\n`/`\r`-terminated line.
    fn push(&mut self, chunk: &[u8], on_line: &mut dyn FnMut(&str)) {
        self.pending.extend_from_slice(chunk);

        let mut start = 0;
        while let Some(offset) = self.pending[start..]
            .iter()
            .position(|byte| *byte == b'\n' || *byte == b'\r')
        {
            let end = start + offset;
            let line = self.pending[start..end].to_vec();
            self.emit(&line, on_line);
            start = end + 1;
        }
        if start > 0 {
            self.pending.drain(..start);
        }
    }

    fn finish(&mut self, on_line: &mut dyn FnMut(&str)) {
        if !self.pending.is_empty() {
            let pending = std::mem::take(&mut self.pending);
            self.emit(&pending, on_line);
        }
    }

    fn emit(&mut self, bytes: &[u8], on_line: &mut dyn FnMut(&str)) {
        let raw = String::from_utf8_lossy(bytes);
        let line = clean_line(&strip_ansi(&raw));
        if line.is_empty() || self.tail.back().is_some_and(|prev| *prev == line) {
            return;
        }
        if self.tail.len() == TAIL_LIMIT {
            self.tail.pop_front();
        }
        self.tail.push_back(line.clone());
        on_line(&line);
    }
}

/// Remove ANSI CSI/OSC escape sequences from a line of terminal output.
fn strip_ansi(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            output.push(ch);
            continue;
        }

        match chars.next() {
            Some('[') => {
                // CSI: consume parameter bytes until the final byte (0x40..=0x7e).
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: consume until BEL or ST (ESC followed by a backslash).
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) | None => {}
        }
    }

    output
}

fn clean_line(line: &str) -> String {
    line.chars()
        .filter(|ch| *ch == '\t' || !ch.is_control())
        .collect::<String>()
        .trim()
        .to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ansi_sequences_are_stripped() {
        assert_eq!(
            strip_ansi("\u{1b}[32m✔\u{1b}[0m container started"),
            "✔ container started"
        );
        assert_eq!(strip_ansi("a\u{1b}]0;title\u{7}b"), "ab");
    }

    #[test]
    fn lines_split_on_carriage_returns_and_newlines() {
        let mut assembler = LineAssembler::default();
        let mut lines = Vec::new();
        assembler.push(b"one\rtwo\nthr", &mut |line| lines.push(line.to_string()));
        assembler.push(b"ee\r\nfour", &mut |line| lines.push(line.to_string()));
        assembler.finish(&mut |line| lines.push(line.to_string()));

        assert_eq!(lines, ["one", "two", "three", "four"]);
    }

    #[test]
    fn blank_and_repeated_lines_are_dropped() {
        let mut assembler = LineAssembler::default();
        let mut lines = Vec::new();
        assembler.push(b"\n\nsame\nsame\nother\n", &mut |line| {
            lines.push(line.to_string())
        });

        assert_eq!(lines, ["same", "other"]);
    }

    #[test]
    fn command_output_is_streamed_in_line_order() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("printf 'alpha\\nbeta\\n'");
        let mut lines = Vec::new();

        let output = run_streaming(command, &mut |line| lines.push(line.to_string()))
            .expect("streaming command");

        assert!(output.status.success());
        assert_eq!(lines, ["alpha", "beta"]);
    }

    #[test]
    fn failed_command_keeps_its_output_for_the_error() {
        let mut command = Command::new("sh");
        command.arg("-c").arg("printf 'boom\\n' >&2; exit 3");

        let output = run_streaming(command, &mut |_| {}).expect("streaming command");

        assert!(!output.status.success());
        assert_eq!(output.tail, ["boom"]);
    }
}
