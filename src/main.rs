//! churn — interactive installer for the torrent/media stack.
//!
//! Pick which machines' roles to set up; the questions each stack needs are
//! collected once and shared, so selecting both `server` and `torrent` asks for
//! the media path a single time.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::net::{SocketAddr, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

use cliclack::{
    confirm, input, intro, log, multiselect, note, outro, outro_cancel, outro_note, password,
    spinner,
};

use churn::assets;
use churn::envfile;
use churn::jellyfin::{self, Credentials, Jellyfin};
use churn::live::LiveLog;
use churn::migrate;
use churn::mullvad;
use churn::ports::{self, Port};
use churn::question;
use churn::question::{Question, Section};
use churn::stack::{
    self, Answers, DASHBOARD_IMAGE_ENV, DASHBOARD_IMAGE_REPO, DASHBOARD_SERVICE, Stack,
};
use churn::system;
use churn::update;

const HELP: &str = "\
churn — installer for the torrent/media stack

Must be run as root (for example: sudo churn). If Docker is missing, churn
offers to install it for the detected Linux distribution. After writing each
stack's .env, it starts the stack with docker compose up -d and completes Jellyfin
first-run setup, writing a generated API key to server/.env. Use --uninstall to
stop/remove the containers and delete generated config without touching DATA_DIR.

USAGE:
    churn [OPTIONS]
    churn show [--stacks <LIST>]
    churn update [OPTIONS]
    churn migrate [--to <PATH>] [OPTIONS]

COMMANDS:
    show              print the URLs for the installed services; does not need
                      root and does not start or change anything
    update            update the churn binary and/or the server dashboard to the
                      latest release; see update options below
    migrate           copy DATA_DIR to a new host path, verify the copy, rewrite
                      both .env files and restart the stacks; the old copy is
                      kept unless --move is given

OPTIONS:
    --stacks <LIST>   comma separated: server,torrent (skips the menu; with
                      --uninstall, show or migrate, limits what is handled)
    --uninstall       stop and remove the stack containers, then delete their
                      generated config, cache and .env files; DATA_DIR is kept
    --dry-run         show the plan; write, remove, copy and start nothing
    -y, --yes         skip the final confirmation
    -h, --help        show this help

MIGRATE OPTIONS:
    --to <PATH>       destination directory; prompted when omitted
    --move            delete the old copy after the new one is verified and the
                      stacks restart (alias: --delete-old)
    --keep-old        keep the old copy (default; alias: --copy)
    --allow-network-fs
                      allow a network filesystem as the destination, which is
                      unsafe for SQLite and interactive media use

UPDATE OPTIONS:
    --check           print installed and latest versions; change nothing
    --to <VERSION>    update to a specific X.Y.Z instead of the latest release
    --image <REF>     override the dashboard image reference (development)
    --binary-only     update the churn binary, skip the dashboard
    --dashboard-only  update the dashboard, skip the churn binary
    --force           re-download/re-pull even when already up to date";

#[derive(Default)]
struct Args {
    show: bool,
    update: bool,
    check: bool,
    stacks: Option<Vec<Stack>>,
    to: Option<String>,
    image: Option<String>,
    binary_only: bool,
    dashboard_only: bool,
    force: bool,
    uninstall: bool,
    migrate: bool,
    move_old: bool,
    keep_old: bool,
    allow_network_fs: bool,
    dry_run: bool,
    yes: bool,
    help: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args::default();
    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        match arg.as_str() {
            "--stacks" | "-s" => {
                let value = raw.next().ok_or("--stacks needs a value")?;
                args.stacks = Some(parse_stack_list(&value)?);
            }
            "show" => args.show = true,
            "update" => args.update = true,
            "migrate" => args.migrate = true,
            "--check" => args.check = true,
            "--to" => {
                let value = raw.next().ok_or("--to needs a path or version")?;
                args.to = Some(value);
            }
            "--image" => {
                let value = raw.next().ok_or("--image needs a reference")?;
                args.image = Some(value);
            }
            "--binary-only" => args.binary_only = true,
            "--dashboard-only" => args.dashboard_only = true,
            "--force" => args.force = true,
            "--uninstall" => args.uninstall = true,
            "--move" | "--delete-old" => args.move_old = true,
            "--keep-old" | "--copy" => args.keep_old = true,
            "--allow-network-fs" => args.allow_network_fs = true,
            "--dry-run" => args.dry_run = true,
            "-y" | "--yes" => args.yes = true,
            "-h" | "--help" => args.help = true,
            other if other.starts_with("--stacks=") => {
                args.stacks = Some(parse_stack_list(&other["--stacks=".len()..])?);
            }
            other if other.starts_with("--to=") => {
                args.to = Some(other["--to=".len()..].to_string());
            }
            other if other.starts_with("--image=") => {
                args.image = Some(other["--image=".len()..].to_string());
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    validate_args(&args)?;
    Ok(args)
}

fn validate_args(args: &Args) -> Result<(), String> {
    let commands = [args.show, args.update, args.uninstall, args.migrate]
        .into_iter()
        .filter(|chosen| *chosen)
        .count();
    if commands > 1 {
        return Err("'show', 'update', '--uninstall' and 'migrate' cannot be combined".to_string());
    }

    let update_option =
        args.check || args.image.is_some() || args.binary_only || args.dashboard_only || args.force;
    if !args.update && update_option {
        return Err("update options require the 'update' command".to_string());
    }
    if args.to.is_some() && !args.update && !args.migrate {
        return Err("--to requires the 'update' or 'migrate' command".to_string());
    }
    if (args.move_old || args.keep_old || args.allow_network_fs) && !args.migrate {
        return Err("migrate options require the 'migrate' command".to_string());
    }
    if args.move_old && args.keep_old {
        return Err("--move and --keep-old are mutually exclusive".to_string());
    }

    if args.update {
        if args.binary_only && args.dashboard_only {
            return Err("--binary-only and --dashboard-only are mutually exclusive".to_string());
        }
        if let Some(stacks) = &args.stacks
            && stacks.iter().any(|stack| *stack != Stack::Server)
        {
            return Err("churn update only supports the server stack".to_string());
        }
    }
    Ok(())
}

fn parse_stack_list(value: &str) -> Result<Vec<Stack>, String> {
    let mut chosen = Vec::new();
    for token in value.split(',').map(str::trim).filter(|t| !t.is_empty()) {
        let stack = Stack::ALL
            .into_iter()
            .find(|stack| stack.key().eq_ignore_ascii_case(token))
            .ok_or_else(|| {
                format!(
                    "unknown stack {token:?} — expected one of: {}",
                    Stack::ALL.map(Stack::key).join(", ")
                )
            })?;
        if !chosen.contains(&stack) {
            chosen.push(stack);
        }
    }
    if chosen.is_empty() {
        return Err("no stacks selected".to_string());
    }
    Ok(chosen)
}

// ---------------------------------------------------------------- orchestrator
fn choose_stacks(args: &Args) -> io::Result<Vec<Stack>> {
    let chose = if let Some(explicit) = &args.stacks {
        explicit.clone()
    } else {
        let mut prompt = multiselect::<Stack>("Which installers should this machine run?");
        for stack in Stack::ALL {
            prompt = prompt.item(stack, stack.key(), stack.description());
        }
        prompt.interact()?
    };
    // Always start `server` before `torrent`: prowlarr-init wires Sonarr/Radarr
    // and needs their API keys, which the server stack writes on startup.
    Ok(stack::start_order(chose))
}

fn ask_questions(
    questions: &[Question],
    assume_yes: bool,
    existing_ports: &HashMap<Port, u16>,
) -> std::io::Result<HashMap<Question, String>> {
    // Values from *any* stack's existing .env: a torrent-only rerun should reuse
    // the media path the server installer already chose on this machine.
    let mut defaults: HashMap<Question, String> = HashMap::new();
    for stack in Stack::ALL {
        for (question, value) in stack.stored_answers() {
            // Prefer the stack that owns a port; the other stack's copy can be
            // stale after a partial install.
            if let Question::Port(port) = question {
                if port.stack() != stack {
                    continue;
                }
            }
            defaults.entry(question).or_insert(value);
        }
    }
    // An older .env may predate configurable ports. The running containers
    // still know which host ports this installation already owns, so reuse
    // those instead of treating our own listeners as port conflicts.
    for (port, number) in existing_ports {
        defaults
            .entry(Question::Port(*port))
            .or_insert_with(|| number.to_string());
    }
    let stored = |question: &Question| defaults.get(question).map(String::as_str);

    let mut answers = Answers::new();
    let mut assigned_ports = Vec::new();
    let mut current = None;
    for question in questions {
        let section = question.section();
        if current != Some(section) {
            explain(section);
            current = Some(section);
        }
        if let Question::Port(port) = question {
            let value = resolve_port(
                *question,
                *port,
                stored(question),
                &assigned_ports,
                assume_yes,
            )?;
            assigned_ports.push(value);
            answers.insert(*question, value.to_string());
            continue;
        }
        if *question == Question::WireguardArchive {
            loop {
                let archive = question.ask(stored(question))?;
                match mullvad::select_config(Path::new(&archive)) {
                    Ok((entry, config)) => {
                        answers.insert(Question::WireguardArchive, archive);
                        answers.insert(Question::WireguardConfig, entry);
                        answers.insert(Question::WireguardPrivateKey, config.private_key);
                        answers.insert(Question::WireguardAddresses, config.address);
                        break;
                    }
                    Err(message) => log::error(message)?,
                }
            }
            continue;
        }
        answers.insert(*question, question.ask(stored(question))?);
    }
    Ok(answers)
}

/// Reuse a stored port, silently take a free default, or ask only when the
/// default is taken or already assigned to another churn service.
fn resolve_port(
    question: Question,
    port: Port,
    stored: Option<&str>,
    assigned: &[u16],
    assume_yes: bool,
) -> io::Result<u16> {
    if let Some(value) = stored.and_then(|value| ports::validate_port(value).ok()) {
        if !assigned.contains(&value) {
            return Ok(value);
        }
        log::warning(format!(
            "Port {value} is stored for more than one service; picking a new {} port.",
            port.label().to_ascii_lowercase()
        ))?;
    }

    let default = port.default_port();
    if !assigned.contains(&default) && port.is_free(default) {
        return Ok(default);
    }

    // Keep away from every other default, even if that service has not been
    // processed yet and may itself move later.
    let mut reserved = assigned.to_vec();
    reserved.extend(
        Port::ALL
            .iter()
            .filter(|other| **other != port)
            .map(|other| other.default_port()),
    );
    let suggested = ports::nearest_free(default, &reserved, port);

    if assume_yes {
        log::warning(format!(
            "Port {default} is unavailable; using {suggested} for the {}.",
            port.label().to_ascii_lowercase()
        ))?;
        return Ok(suggested);
    }

    log::warning(format!(
        "Port {default} is already in use; suggesting {suggested}."
    ))?;
    question
        .ask_port(port, suggested, &reserved)?
        .parse()
        .map_err(|_| io::Error::other("internal error: invalid port answer"))
}

fn explain(section: Section) {
    match section {
        Section::Vpn => {
            let _ = note(
                "Where to get these",
                "mullvad.net → Account → WireGuard config → download zip\n\
                 Point churn at the downloaded .zip. It reads PrivateKey and the\n\
                 IPv4 Address from one of the .conf files (any file works — they\n\
                 share the same key).\n\n\
                 Paths: Tab completes, ↑/↓ choose, Enter submits.\n\n\
                 The key is written only to torrent/.env, which is gitignored.",
            );
        }
        Section::Storage => {
            let _ = note(
                "Storage layout",
                "One absolute host path holds media and downloads.\n\
                 It is mounted at /data inside every container, so Jellyfin,\n\
                 Sonarr, Radarr and qBittorrent agree on paths no matter where\n\
                 they run.\n\n\
                 Paths: Tab completes, ↑/↓ choose, Enter submits.",
            );
        }
    }
}

fn ensure_data_dir(answers: &Answers) -> io::Result<()> {
    let Some(path) = answers.get(&Question::DataDir) else {
        return Ok(());
    };
    let path = Path::new(path);
    if path.is_dir() {
        return Ok(());
    }
    log::warning(format!("{} does not exist yet", path.display()))?;
    if confirm(format!("Create {}?", path.display()))
        .initial_value(true)
        .interact()?
    {
        std::fs::create_dir_all(path)?;
        log::success(format!("created {}", path.display()))?;
    } else {
        return Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "data dir declined",
        ));
    }
    Ok(())
}

fn show_plan(chosen: &[Stack], questions: &[Question], answers: &Answers) -> io::Result<()> {
    let mut lines = String::new();
    for stack in chosen {
        lines.push_str(&format!("{:<8} {}\n", stack.key(), stack.description()));
    }
    lines.push('\n');
    for question in questions.iter().copied().chain(Question::DETAILS) {
        if let Some(value) = stack::summary(question, answers) {
            lines.push_str(&format!("{:<30} {value}\n", question.label()));
        }
    }
    if chosen.contains(&Stack::Server) {
        lines.push_str(
            "\nJellyfin will be set up after it starts. If it needs an admin account,\n\
             churn asks for the username and password then (the password is not saved).\n",
        );
    }
    note("About to install", lines.trim_end().to_string())
}

/// Inspect existing Compose projects for published ports. Only stacks with
/// generated state are queried, so a fresh install stays offline and quiet.
fn existing_ports(chosen: &[Stack]) -> HashMap<Port, u16> {
    let mut found = HashMap::new();
    for stack in chosen {
        if !stack.env_path().is_file() || !stack.dir().join("docker-compose.yml").is_file() {
            continue;
        }
        let services = match system::compose_ps(&stack.dir()) {
            Ok(services) => services,
            Err(err) => {
                let _ = log::warning(format!(
                    "could not inspect the existing {} stack: {err}",
                    stack.key()
                ));
                continue;
            }
        };
        for port in Port::ALL.into_iter().filter(|port| port.stack() == *stack) {
            if let Some(published) = port.published_in(&services) {
                found.insert(port, published);
            }
        }

        // The dashboard uses host networking, so Compose reports no published
        // port for it. Its container environment still has the effective PORT.
        if *stack == Stack::Server && !found.contains_key(&Port::Dashboard) {
            let port = Port::Dashboard;
            if let Ok(Some(value)) =
                system::compose_service_env(&stack.dir(), port.compose_service(), "PORT")
                && let Ok(number) = ports::validate_port(value.trim())
            {
                found.insert(port, number);
            }
        }
    }
    found
}

fn preflight(chosen: &[Stack]) -> io::Result<HashMap<Port, u16>> {
    let findings: Vec<String> = chosen.iter().flat_map(|stack| stack.preflight()).collect();
    for finding in &findings {
        log::warning(finding)?;
    }
    if findings.is_empty() {
        log::success("host prerequisites look fine")?;
    }

    let existing = existing_ports(chosen);
    if !existing.is_empty() {
        let ports = Port::ALL
            .into_iter()
            .filter_map(|port| {
                existing
                    .get(&port)
                    .map(|number| format!("{} {number}", port.service_name()))
            })
            .collect::<Vec<_>>()
            .join(", ");
        log::success(format!(
            "found an existing installation; reusing its published ports: {ports}"
        ))?;
    }
    Ok(existing)
}

/// Stop unless we have root, since the installer writes root-owned files and
/// installs packages.
fn ensure_root() -> io::Result<bool> {
    if system::is_root() {
        return Ok(true);
    }
    outro_note(
        "Root access required",
        "churn must run as root. Re-run it with sudo:\n\n    sudo churn",
    )?;
    Ok(false)
}

/// Check for Docker before asking anything, and offer to install it when it is
/// missing (or when the Compose plugin is missing).
fn ensure_docker() -> io::Result<bool> {
    if system::docker_ready() {
        log::success("docker and the compose plugin are available")?;
        return Ok(true);
    }

    log::warning("docker with the compose plugin was not found")?;
    if !confirm("Install Docker now with this installer?")
        .initial_value(true)
        .interact()?
    {
        outro_note(
            "Docker is required",
            "Install Docker (including the compose plugin), then re-run churn once it is available.",
        )?;
        return Ok(false);
    }

    let distro = system::Distro::from_host();
    let Some(steps) = distro.install_steps() else {
        outro_note(
            format!("Unsupported distribution: {}", distro.display_name()),
            "churn can install Docker automatically on Ubuntu, Debian, Fedora and Arch Linux.\n\
             Install Docker manually from https://docs.docker.com/engine/install/, then re-run churn.",
        )?;
        return Ok(false);
    };

    log::info(format!("installing Docker for {}", distro.display_name()))?;
    let progress = spinner();
    for (index, step) in steps.iter().enumerate() {
        progress.start(format!(
            "[{}/{}] {}",
            index + 1,
            steps.len(),
            step.description
        ));
        if let Err(err) = system::run_step(step) {
            progress.stop(format!("failed: {}", step.description));
            return Err(err);
        }
        progress.stop(step.description);
    }

    if !system::docker_ready() {
        return Err(io::Error::other(
            "docker was installed but is not usable yet — check `docker compose version` and re-run churn",
        ));
    }
    log::success("docker installed and ready")?;
    Ok(true)
}

/// Jellyfin is configured over its HTTP API after the server stack starts.
/// This creates the first admin account when needed, completes the startup
/// wizard, mints an API key and writes it to `server/.env`.
fn setup_jellyfin(dry_run: bool) -> io::Result<()> {
    if dry_run {
        log::info("would complete Jellyfin setup and create an API key")?;
        return Ok(());
    }

    let env_path = Stack::Server.env_path();
    let env = envfile::read(&env_path);
    let jellyfin_port = env
        .get("JELLYFIN_PORT")
        .and_then(|value| ports::validate_port(value).ok())
        .unwrap_or_else(|| Port::Jellyfin.default_port());
    let base_url = std::env::var("JELLYFIN_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env.get("JELLYFIN_URL").cloned())
        .unwrap_or_else(|| format!("http://127.0.0.1:{jellyfin_port}"));
    let client = Jellyfin::new(base_url, Duration::from_secs(5));

    let progress = spinner();
    progress.start("waiting for Jellyfin");
    let public = match client.wait_until_ready(Duration::from_secs(120)) {
        Ok(public) => {
            let version = public
                .version
                .as_deref()
                .map(|version| format!(" {version}"))
                .unwrap_or_default();
            progress.stop(format!("Jellyfin{version} is ready"));
            public
        }
        Err(err) => {
            progress.stop("Jellyfin did not become ready");
            return Err(err);
        }
    };

    let existing_key = std::env::var(jellyfin::API_KEY_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| env.get(jellyfin::API_KEY_ENV).cloned());
    let existing_key = match existing_key {
        Some(key) => match client.validate_api_key(&key) {
            Ok(true) => {
                log::success("Jellyfin is already configured and its API key is valid")?;
                Some(key)
            }
            Ok(false) => {
                log::warning("the existing Jellyfin API key is invalid — creating a new one")?;
                None
            }
            Err(err) => return Err(err),
        },
        None => None,
    };

    let api_key = match existing_key {
        Some(key) => key,
        None => {
            let credentials = jellyfin_credentials(&env)?;
            let progress = spinner();
            progress.start("setting up Jellyfin and creating an API key");
            match client.provision(&env_path, &credentials, &public) {
                Ok(result) => {
                    if result.completed_setup {
                        progress.stop("Jellyfin setup complete; API key saved to server/.env");
                    } else {
                        progress.stop("Jellyfin API key saved to server/.env");
                    }
                    log::info(format!(
                        "Jellyfin admin user: {} (keep the password you entered)",
                        credentials.username
                    ))?;
                    result.api_key
                }
                Err(err) => {
                    progress.stop("Jellyfin setup failed");
                    return Err(err);
                }
            }
        }
    };

    let progress = spinner();
    progress.start("checking Jellyfin libraries");
    match client.ensure_libraries(&api_key) {
        Ok(changes) if changes.is_empty() => {
            progress.stop("Jellyfin libraries are already configured");
        }
        Ok(changes) => {
            progress.stop("Jellyfin libraries are configured");
            for change in changes {
                log::info(change)?;
            }
        }
        Err(err) => {
            progress.stop("could not configure Jellyfin libraries");
            return Err(err);
        }
    }

    let progress = spinner();
    progress.start("checking Jellyfin tailnet access");
    match client.ensure_tailnet_access(&api_key) {
        Ok(true) => {
            progress.stop("Jellyfin now allows Tailscale clients");
            let progress = spinner();
            progress.start("restarting Jellyfin to apply network settings");
            match client.restart_and_wait(&api_key, Duration::from_secs(120)) {
                Ok(()) => progress.stop("Jellyfin restarted"),
                Err(err) => {
                    progress.stop("could not restart Jellyfin");
                    return Err(err);
                }
            }
        }
        Ok(false) => progress.stop("Jellyfin already allows Tailscale clients"),
        Err(err) => {
            progress.stop("could not allow Tailscale clients in Jellyfin");
            return Err(err);
        }
    }

    restart_dashboard()
}

/// The dashboard reads `JELLYFIN_API_KEY` from `.env` at boot, but churn only
/// writes that key after the stack is up. Recreate the dashboard once setup has
/// completed so it starts with the key instead of running without one.
fn restart_dashboard() -> io::Result<()> {
    let mut live = LiveLog::start("restarting the dashboard with the Jellyfin API key");
    match system::compose_recreate_service(
        &Stack::Server.dir(),
        stack::DASHBOARD_SERVICE,
        &mut |line| live.push(line),
    ) {
        Ok(()) => {
            live.success("dashboard restarted with the Jellyfin API key");
            Ok(())
        }
        Err(err) => {
            live.error("dashboard restart failed");
            Err(err)
        }
    }
}

fn jellyfin_credentials(env: &envfile::EnvMap) -> io::Result<Credentials> {
    let env_value = |key: &str| {
        std::env::var(key)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                env.get(key)
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
    };

    let default_username = env_value("JELLYFIN_ADMIN_USER").unwrap_or_else(|| "admin".to_string());
    let username = loop {
        let value: String = input("Jellyfin admin username")
            .placeholder("admin")
            .default_input(&default_username)
            .interact()?;
        let value = value.trim().to_string();
        match jellyfin::validate_username(&value) {
            Ok(()) => break value,
            Err(message) => log::error(message)?,
        }
    };

    let stored_password = env_value("JELLYFIN_ADMIN_PASSWORD");
    let password = if let Some(value) = stored_password {
        jellyfin::validate_password(&value).map_err(io::Error::other)?;
        value
    } else {
        loop {
            let first: String = password("Choose a Jellyfin admin password").interact()?;
            if let Err(message) = jellyfin::validate_password(&first) {
                log::error(message)?;
                continue;
            }
            let second: String = password("Confirm the Jellyfin admin password").interact()?;
            if first != second {
                log::error("Passwords do not match.")?;
                continue;
            }
            break first;
        }
    };

    log::info("the Jellyfin admin password is not stored by churn")?;
    Ok(Credentials { username, password })
}

fn write_stacks(chosen: &[Stack], answers: &Answers, dry_run: bool) -> io::Result<()> {
    let root = envfile::root();
    let progress = spinner();
    for (index, stack) in chosen.iter().enumerate() {
        progress.start(format!(
            "[{}/{}] writing {}",
            index + 1,
            chosen.len(),
            stack.key()
        ));
        if dry_run {
            progress.stop(format!(
                "would write {} stack files and {}",
                stack.key(),
                stack.env_path().display()
            ));
            continue;
        }
        match assets::materialize(&root, *stack).and_then(|()| stack.apply(answers)) {
            Ok(path) => {
                progress.stop(format!("wrote stack files and {}", path.display()));
            }
            Err(err) => {
                progress.stop(format!("failed to write {} stack files", stack.key()));
                return Err(err);
            }
        }
    }
    Ok(())
}

fn start_stacks(chosen: &[Stack], dry_run: bool) -> io::Result<()> {
    for (index, stack) in chosen.iter().enumerate() {
        let header = format!("[{}/{}] starting {}", index + 1, chosen.len(), stack.key());
        if dry_run {
            let progress = spinner();
            progress.start(&header);
            progress.stop(format!("would start {}", stack.key()));
            continue;
        }

        if *stack == Stack::Torrent {
            let progress = spinner();
            progress.start("checking torrent VPN isolation");
            if let Err(err) = system::verify_torrent_isolation(&stack.dir()) {
                progress.stop("torrent VPN isolation check failed");
                return Err(err);
            }
            progress.stop("torrent VPN isolation check passed");

            let progress = spinner();
            progress.start("checking Docker's torrent network route");
            if let Err(err) = system::verify_compose_default_route(&stack.dir(), "gluetun") {
                progress.stop("Docker's torrent network has no default route");
                return Err(err);
            }
            progress.stop("Docker's torrent network has a default route");
        }

        let mut live = LiveLog::start(header);
        let result = system::compose_up(&stack.dir(), &mut |line| live.push(line));
        match result {
            Ok(()) => live.success(format!("started {}", stack.key())),
            Err(err) => {
                live.error(format!("failed to start {}", stack.key()));
                return Err(err);
            }
        }
    }
    Ok(())
}

/// Stop/remove containers and delete generated state, while keeping `DATA_DIR`.
fn uninstall(args: Args) -> io::Result<bool> {
    intro("churn · torrent stack uninstaller")?;

    if !ensure_root()? {
        return Ok(false);
    }

    let chosen = stack::start_order(args.stacks.clone().unwrap_or_else(|| Stack::ALL.to_vec()));

    let mut lines = String::new();
    for stack in &chosen {
        lines.push_str(&format!("{}\n", stack.key()));
        for path in stack.state_paths() {
            lines.push_str(&format!("  delete {}\n", path.display()));
        }
    }
    lines.push_str(
        "\nDATA_DIR, media, downloads and images are left untouched.\nThe dashboard cache and auth-state volumes are removed.",
    );
    note("About to uninstall", lines.trim_end().to_string())?;

    if !args.yes
        && !confirm(if args.dry_run {
            "Remove these containers and files?"
        } else {
            "Stop and remove the containers, then delete these files?"
        })
        .initial_value(true)
        .interact()?
    {
        outro_cancel("cancelled — nothing removed")?;
        return Ok(true);
    }

    if args.dry_run {
        outro("dry run complete — nothing removed")?;
        return Ok(true);
    }

    if !system::docker_ready() {
        log::warning("docker is not available — skipping container removal")?;
    } else {
        let mut errors = Vec::new();
        for (index, stack) in chosen.iter().enumerate() {
            let header = format!("[{}/{}] removing {}", index + 1, chosen.len(), stack.key());
            let mut live = LiveLog::start(header);
            match system::compose_down(&stack.dir(), &mut |line| live.push(line)) {
                Ok(()) => live.success(format!("removed {} containers", stack.key())),
                Err(err) => {
                    live.error(format!("failed to remove {}", stack.key()));
                    errors.push(err.to_string());
                }
            }
        }
        if !errors.is_empty() {
            return Err(io::Error::other(format!(
                "could not remove all containers; config files were left untouched:\n{}",
                errors.join("\n")
            )));
        }
    }

    let progress = spinner();
    for stack in &chosen {
        for path in stack.state_paths() {
            progress.start(format!("removing {}", path.display()));
            if !path.exists() {
                progress.stop(format!("already gone: {}", path.display()));
                continue;
            }
            if path.is_dir() {
                fs::remove_dir_all(&path)?;
            } else {
                fs::remove_file(&path)?;
            }
            progress.stop(format!("removed {}", path.display()));
        }
    }

    outro("uninstalled — data and compose files were left in place")?;
    Ok(true)
}

// ---------------------------------------------------------------- migrate

fn show_migration_plan(plan: &migrate::Plan, args: &Args) -> io::Result<()> {
    let mut lines = String::new();
    lines.push_str(&format!("{:<14} {}\n", "from", plan.source.display()));
    lines.push_str(&format!("{:<14} {}\n", "to", plan.destination.display()));
    lines.push_str(&format!(
        "{:<14} {}\n",
        "size",
        migrate::format_bytes(plan.total_bytes)
    ));
    if plan.resuming {
        lines.push_str(&format!(
            "{:<14} {} (resuming a partial copy)\n",
            "still to copy",
            migrate::format_bytes(plan.remaining_bytes)
        ));
    }
    lines.push_str(&format!(
        "{:<14} {}\n",
        "free space",
        migrate::format_bytes(plan.available_bytes)
    ));
    lines.push_str(&format!(
        "{:<14} {}\n",
        "stacks",
        plan.stacks
            .iter()
            .map(|stack| stack.key())
            .collect::<Vec<_>>()
            .join(", ")
    ));
    lines.push_str(&format!(
        "{:<14} {}\n",
        "old data",
        if args.move_old {
            "deleted after verification and a healthy restart"
        } else {
            "kept (rollback stays possible)"
        }
    ));
    if plan.network_filesystem {
        lines.push_str("\nThe destination is a network filesystem. SQLite databases and\ninteractive media playback can misbehave on network storage.\n");
    }
    if plan.resuming && plan.remaining_bytes == 0 {
        lines.push_str(
            "\nThe destination already contains at least the source's total bytes. This is\n             a size-only estimate: it does not prove every file is present or valid. rsync\n             re-checks the tree and churn verifies it again before changing .env, but a\n             previous read error can leave a same-size file that is still corrupt.\n",
        );
    }
    note("About to migrate", lines.trim_end().to_string())
}

fn configured_port(stack: Stack, port: Port) -> u16 {
    envfile::read(&stack.env_path())
        .get(port.env_key())
        .and_then(|value| ports::validate_port(value).ok())
        .unwrap_or_else(|| port.default_port())
}

fn wait_for_tcp(port: u16, timeout: Duration) -> io::Result<()> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = Instant::now() + timeout;
    loop {
        if TcpStream::connect_timeout(&address, Duration::from_secs(2)).is_ok() {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "{address} did not accept connections within {}s",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn stop_stacks(stacks: &[Stack]) -> io::Result<()> {
    for (index, stack) in stacks.iter().enumerate() {
        let header = format!("[{}/{}] stopping {}", index + 1, stacks.len(), stack.key());
        let mut live = LiveLog::start(header);
        match system::compose_stop(&stack.dir(), &mut |line| live.push(line)) {
            Ok(()) => live.success(format!("stopped {}", stack.key())),
            Err(err) => {
                live.error(format!("failed to stop {}", stack.key()));
                return Err(err);
            }
        }
    }
    Ok(())
}

fn with_restart(error: io::Error, restart: io::Result<()>) -> io::Error {
    match restart {
        Ok(()) => io::Error::new(
            error.kind(),
            format!(
                "{error}\nThe original stacks were restarted on the old data.\n\
                 The partial copy and its marker were kept; re-run the same command to resume."
            ),
        ),
        Err(restart_error) => io::Error::new(
            error.kind(),
            format!(
                "{error}\nRestarting the original stacks also failed: {restart_error}\n\
                 Fix the stack with `docker compose up -d` in each stack directory."
            ),
        ),
    }
}

fn migrate_storage(args: &Args) -> io::Result<bool> {
    intro("churn · data migration")?;

    if !ensure_root()? {
        return Ok(false);
    }

    let root = envfile::root();
    let installed = migrate::installed_stacks(&root);
    if installed.is_empty() {
        outro_note(
            "Nothing to migrate",
            format!(
                "No installed stacks were found under {}.\nRun `sudo churn` first.",
                root.display()
            ),
        )?;
        return Ok(false);
    }

    if let Some(explicit) = &args.stacks {
        if let Some(missing) = installed.iter().find(|stack| !explicit.contains(stack)) {
            outro_note(
                "Both stacks share DATA_DIR",
                format!(
                    "The {} stack is installed and uses the same data directory.\n\
                     Migrate both stacks together so they do not point at different copies.",
                    missing.key()
                ),
            )?;
            return Ok(false);
        }
        if let Some(extra) = explicit.iter().find(|stack| !installed.contains(stack)) {
            outro_note(
                "Stack not installed",
                format!(
                    "The {} stack has no generated .env under {}.",
                    extra.key(),
                    root.display()
                ),
            )?;
            return Ok(false);
        }
    }
    let stacks = installed;

    if !args.dry_run && !system::docker_ready() {
        outro_note(
            "Docker is required",
            "Docker with the compose plugin must be running to stop and restart the stacks.",
        )?;
        return Ok(false);
    }

    let source = match migrate::current_data_dir(&root, &stacks) {
        Ok(source) => source,
        Err(err) => {
            outro_cancel(format!("cannot migrate: {err}"))?;
            return Ok(false);
        }
    };
    let destination_value = match &args.to {
        Some(value) => question::normalize_path(value),
        None => question::ask_directory(
            &format!("Old location: {}\nNew location", source.display()),
            None,
            "/mnt/media",
        )?,
    };
    let plan = match migrate::plan(
        &root,
        &stacks,
        Path::new(&destination_value),
        args.allow_network_fs,
    ) {
        Ok(plan) => plan,
        Err(err) => {
            outro_cancel(format!("cannot migrate: {err}"))?;
            return Ok(false);
        }
    };

    show_migration_plan(&plan, args)?;

    if !args.yes {
        let prompt = if args.dry_run {
            "Show this migration plan?"
        } else if args.move_old {
            "Stop the stacks, copy the data, and delete the old copy once verified?"
        } else {
            "Stop the stacks, copy the data, and keep the old copy?"
        };
        if !confirm(prompt).initial_value(true).interact()? {
            outro_cancel("cancelled — nothing stopped and nothing copied")?;
            return Ok(true);
        }
    }

    if args.dry_run {
        outro("dry run complete — nothing stopped, copied or changed")?;
        return Ok(true);
    }

    if let Err(err) = migrate::write_marker(&plan.source, &plan.destination) {
        outro_cancel(format!("could not write the migration marker: {err}"))?;
        return Ok(false);
    }

    if let Err(err) = stop_stacks(&stacks) {
        // The marker is kept even here: the destination may be empty, and a
        // rerun can resume by creating the copy from scratch.
        let restart = start_stacks(&stacks, false);
        return Err(with_restart(err, restart));
    }

    let mut live = LiveLog::start(format!(
        "copying {} to {}",
        plan.source.display(),
        plan.destination.display()
    ));
    let copied = migrate::copy(&plan.source, &plan.destination, &mut |line| live.push(line));
    if let Err(err) = copied {
        live.error("copy failed; the old data is untouched");
        let restart = start_stacks(&stacks, false);
        return Err(with_restart(err, restart));
    }
    live.success(format!(
        "copied {}",
        migrate::format_bytes(plan.total_bytes)
    ));

    let (uid, gid) = migrate::storage_owner(&root, &stacks, &plan.destination);
    if let Err(err) = migrate::set_owner(&plan.destination, uid, gid) {
        log::warning(format!(
            "could not set {} ownership to {uid}:{gid}: {err}",
            plan.destination.display()
        ))?;
    }

    let progress = spinner();
    progress.start("verifying the copy");
    match migrate::verify_tree(&plan.source, &plan.destination) {
        Ok(report) => progress.stop(format!(
            "verified {} files ({})",
            report.files,
            migrate::format_bytes(report.bytes)
        )),
        Err(err) => {
            progress.stop("copy verification failed");
            let restart = start_stacks(&stacks, false);
            return Err(with_restart(err, restart));
        }
    }

    let backups = match migrate::write_envs(&root, &stacks, &plan.destination, uid, gid) {
        Ok(backups) => backups,
        Err(err) => {
            let restart = start_stacks(&stacks, false);
            return Err(with_restart(err, restart));
        }
    };

    if let Err(err) = start_stacks(&stacks, false) {
        let restored = migrate::restore_envs(&backups);
        let restart = start_stacks(&stacks, false);
        return Err(io::Error::other(format!(
            "the stacks did not start with the new location: {err}\n{}\n\
             The destination and its marker were kept; re-run the same command to retry.",
            match (restored, restart) {
                (Ok(()), Ok(())) => {
                    "the .env files were rolled back and the original stacks were restarted."
                        .to_string()
                }
                (Ok(()), Err(restart)) => format!(
                    ".env files were rolled back, but restarting the original stacks failed: {restart}"
                ),
                (Err(restore), _) => format!(
                    "restoring the .env files also failed: {restore}\n{}",
                    plan.rollback_hint(&root)
                ),
            }
        )));
    }

    // The data is verified and `.env` now points at it, so the resume marker has
    // done its job. Health checks below do not need it.
    migrate::clear_marker(&plan.destination);

    if stacks.contains(&Stack::Server)
        && let Err(err) = setup_jellyfin(false)
    {
        return Err(io::Error::other(format!(
            "the data is in {} and the stacks are running, but the Jellyfin health check failed: {err}\n\
             Roll back with:\n{}",
            plan.destination.display(),
            plan.rollback_hint(&root)
        )));
    }

    if stacks.contains(&Stack::Torrent) {
        for port in [Port::Qbittorrent, Port::Prowlarr] {
            let number = configured_port(Stack::Torrent, port);
            let progress = spinner();
            progress.start(format!("waiting for {}", port.service_name()));
            match wait_for_tcp(number, Duration::from_secs(120)) {
                Ok(()) => progress.stop(format!("{} is answering", port.service_name())),
                Err(err) => {
                    progress.stop(format!("{} did not become healthy", port.service_name()));
                    return Err(io::Error::other(format!(
                        "the data is in {} and the stacks are running, but the torrent health check failed: {err}\n\
                         Roll back with:\n{}",
                        plan.destination.display(),
                        plan.rollback_hint(&root)
                    )));
                }
            }
        }
    }

    if args.move_old {
        let progress = spinner();
        progress.start(format!(
            "removing the old data in {}",
            plan.source.display()
        ));
        match migrate::remove_old_data(&plan.source) {
            Ok(()) => progress.stop(format!(
                "removed the old data from {}",
                plan.source.display()
            )),
            Err(err) => progress.stop(format!("could not remove the old data: {err}")),
        }
    }
    migrate::clear_marker(&plan.destination);

    let mut details = format!("data now lives at {}\n", plan.destination.display());
    if args.move_old {
        details.push_str(&format!(
            "the old copy under {} was removed; rollback is no longer possible\n",
            plan.source.display()
        ));
    } else {
        details.push_str(&format!(
            "the old copy is still at {}\n",
            plan.source.display()
        ));
        details.push_str("\nRoll back with:\n");
        details.push_str(&plan.rollback_hint(&root));
    }
    outro_note("Migration complete", details)?;
    Ok(true)
}

// ---------------------------------------------------------------- update

fn server_installed() -> bool {
    Stack::Server.env_path().is_file() && Stack::Server.dir().join("docker-compose.yml").is_file()
}

fn configured_dashboard_image() -> Option<String> {
    if !server_installed() {
        return None;
    }
    envfile::read(&Stack::Server.env_path())
        .get(DASHBOARD_IMAGE_ENV)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some(update::image_ref(env!("CARGO_PKG_VERSION"))))
}

fn resolve_target(args: &Args) -> io::Result<String> {
    if let Some(to) = &args.to {
        return update::normalize_version(to).map_err(io::Error::other);
    }

    // A dashboard-only update with an explicit image can work offline; use the
    // image tag as the target when it looks like a version.
    if args.dashboard_only
        && let Some(image) = &args.image
        && let Some(tag) = update::image_tag(image)
    {
        return Ok(update::normalize_version(tag).unwrap_or_else(|_| tag.to_string()));
    }

    if let Ok(value) = std::env::var("CHURN_VERSION") {
        let value = value.trim();
        if !value.is_empty() && !value.eq_ignore_ascii_case("latest") {
            return update::normalize_version(value).map_err(io::Error::other);
        }
    }

    update::fetch_latest_release().map(|release| release.version)
}

fn dashboard_target_ref(args: &Args, target: &str) -> io::Result<String> {
    if let Some(image) = &args.image {
        let image = image.trim();
        if image.is_empty() {
            return Err(io::Error::other("--image needs an image reference"));
        }
        if update::image_tag(image).is_none() {
            return Err(io::Error::other(
                "--image must include a tag, for example ghcr.io/git-monke/churn-dashboard:0.1.4",
            ));
        }
        return Ok(image.to_string());
    }
    Ok(update::image_ref(target))
}

fn current_binary_path() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    Ok(fs::canonicalize(&exe).unwrap_or(exe))
}

fn update_check(args: &Args) -> io::Result<bool> {
    let target = resolve_target(args)?;
    let current_binary = env!("CARGO_PKG_VERSION");
    let installed = server_installed();
    let current_image = configured_dashboard_image();
    let current_dashboard = current_image
        .as_deref()
        .and_then(update::image_tag)
        .unwrap_or("unknown");

    let mut up_to_date = true;
    if !args.dashboard_only {
        let stale = current_binary != target;
        up_to_date &= !stale;
        println!(
            "{:<10} installed {:<10} latest {}",
            "churn", current_binary, target
        );
    }
    if !args.binary_only {
        if !installed {
            if args.dashboard_only {
                return Err(io::Error::other(format!(
                    "the server dashboard is not installed under {}",
                    envfile::root().display()
                )));
            }
            up_to_date = false;
            println!("{:<10} not installed (latest {})", "dashboard", target);
        } else {
            let stale = current_dashboard != target;
            up_to_date &= !stale;
            println!(
                "{:<10} installed {:<10} latest {}",
                "dashboard", current_dashboard, target
            );
        }
    }
    Ok(up_to_date)
}

fn finish_update(child: bool, message: impl Into<String>) -> io::Result<()> {
    let message = message.into();
    if child {
        println!("{message}");
        Ok(())
    } else {
        outro(message)
    }
}

fn update_host(args: &Args) -> io::Result<()> {
    let child = std::env::var_os("CHURN_UPDATE_CHILD").is_some();
    if !child {
        intro("churn · update")?;
    }
    if !args.dry_run && !ensure_root()? {
        return Err(io::Error::other("root access required"));
    }

    let target = resolve_target(args)?;
    let installed = server_installed();
    if args.dashboard_only && !installed {
        return Err(io::Error::other(format!(
            "the server dashboard is not installed under {}; run sudo churn first",
            envfile::root().display()
        )));
    }

    let current_binary = env!("CARGO_PKG_VERSION");
    let current_image = configured_dashboard_image();
    let current_tag = current_image.as_deref().and_then(update::image_tag);
    let want_binary = !args.dashboard_only;
    let want_dashboard = !args.binary_only && installed;

    let binary_path = if want_binary {
        Some(current_binary_path()?)
    } else {
        None
    };
    let binary_managed = binary_path
        .as_deref()
        .is_some_and(|path| !update::is_checkout_binary(path));

    if want_binary && !binary_managed && args.binary_only {
        return Err(io::Error::other(
            "refusing to replace a binary built from a source checkout; use install.sh for a managed install",
        ));
    }

    let binary_needs = want_binary && binary_managed && (current_binary != target || args.force);
    let dashboard_needs = want_dashboard
        && (current_tag != Some(target.as_str()) || args.force || args.image.is_some());

    if !installed && !args.binary_only && (current_binary != target || args.force) {
        log::info("no server install found; updating churn only")?;
    }
    if want_binary && !binary_managed && (current_binary != target || args.force) {
        log::warning("running from a source checkout; skipping the churn binary update")?;
    }

    if !binary_needs && !dashboard_needs {
        let message = if want_binary && !binary_managed && current_binary != target {
            "running from a source checkout; skipping the churn binary update".to_string()
        } else if server_installed() {
            format!("churn {current_binary} and the dashboard are up to date")
        } else {
            format!("churn {current_binary} is up to date")
        };
        cleanup_update_backup();
        finish_update(child, message)?;
        return Ok(());
    }

    let old_ref = current_image
        .clone()
        .unwrap_or_else(|| update::image_ref(current_binary));
    let target_ref = if want_dashboard {
        dashboard_target_ref(args, &target)?
    } else {
        String::new()
    };
    if want_dashboard {
        // Compose gives the process environment precedence over .env. Refuse
        // rather than update an image that compose would ignore.
        if let Ok(value) = std::env::var(DASHBOARD_IMAGE_ENV)
            && !value.trim().is_empty()
        {
            return Err(io::Error::other(format!(
                "{DASHBOARD_IMAGE_ENV} is set in the environment ({value}); unset it before running churn update"
            )));
        }
        if args.image.is_none() && !old_ref.starts_with(&format!("{DASHBOARD_IMAGE_REPO}:")) {
            return Err(io::Error::other(format!(
                "the dashboard is pinned to a custom image ({old_ref}); pass --image <ref> to update it"
            )));
        }
    }

    if !child {
        println!("churn");
        if binary_needs {
            println!(
                "  current  {} {current_binary}",
                binary_path.as_ref().unwrap().display()
            );
            println!(
                "  target   {} {target}",
                binary_path.as_ref().unwrap().display()
            );
        } else if want_binary && !binary_managed {
            println!("  skip     source checkout");
        } else {
            println!("  up to date ({current_binary})");
        }
        if want_dashboard {
            println!("dashboard");
            println!("  current  {old_ref}");
            println!("  target   {target_ref}");
        }
    }

    if args.dry_run {
        if binary_needs {
            log::info(format!("would download churn {target}"))?;
        }
        if dashboard_needs {
            log::info(format!(
                "would pull and recreate dashboard from {target_ref}"
            ))?;
        }
        finish_update(child, "dry run complete — nothing downloaded or started")?;
        return Ok(());
    }

    let prompt = match (binary_needs, dashboard_needs) {
        (true, true) => "Update churn and restart the dashboard?",
        (true, false) => "Update churn?",
        (false, true) => "Pull and restart the dashboard?",
        (false, false) => "Nothing to update",
    };
    if !args.yes && !confirm(prompt).initial_value(true).interact()? {
        if !child {
            outro_cancel("cancelled — nothing changed")?;
        }
        return Ok(());
    }

    if binary_needs {
        let exe = self_update(&target)?;
        if !want_dashboard || !dashboard_needs {
            update::remove_binary_backup(&exe)?;
            finish_update(child, format!("churn updated to {target}"))?;
            return Ok(());
        }

        // The new binary owns the new compose assets. Re-exec it for the
        // dashboard half; --dashboard-only keeps this from recursing.
        let mut command = Command::new(&exe);
        command
            .arg("update")
            .arg("--dashboard-only")
            .arg("--to")
            .arg(&target)
            .arg("--yes");
        if let Some(image) = &args.image {
            command.arg("--image").arg(image);
        }
        if args.force {
            command.arg("--force");
        }
        command.env("CHURN_UPDATE_CHILD", "1");
        let err = command.exec();
        let _ = update::restore_binary(&exe);
        return Err(io::Error::other(format!(
            "could not start the updated churn: {err}"
        )));
    }

    if want_dashboard && dashboard_needs {
        if !system::docker_ready() {
            return Err(io::Error::other(
                "docker with the compose plugin is required to update the dashboard",
            ));
        }
        if let Err(err) = update_dashboard(&target_ref, &old_ref, args.force) {
            let backup = if child { backup_hint() } else { None };
            return Err(io::Error::other(match backup {
                Some(path) => format!("{err}\nprevious churn binary kept at {}", path.display()),
                None => err.to_string(),
            }));
        }
    }

    cleanup_update_backup();
    let message = if want_dashboard {
        format!("churn {current_binary}; dashboard {target_ref}")
    } else {
        format!("churn {current_binary}")
    };
    finish_update(child, message)?;
    Ok(())
}

fn cleanup_update_backup() {
    if let Ok(exe) = current_binary_path() {
        let _ = update::remove_binary_backup(&exe);
    }
}

fn backup_hint() -> Option<PathBuf> {
    let exe = current_binary_path().ok()?;
    let backup = update::binary_backup_path(&exe);
    backup.exists().then_some(backup)
}

fn self_update(version: &str) -> io::Result<PathBuf> {
    let exe = current_binary_path()?;
    if update::is_checkout_binary(&exe) {
        return Err(io::Error::other(format!(
            "refusing to replace the source-checkout binary at {}",
            exe.display()
        )));
    }

    let target = update::release_target().map_err(io::Error::other)?;
    let asset = update::asset_name(target);
    let url = update::release_asset_url(version, &asset);
    let checksum_url = format!("{url}.sha256");

    let progress = spinner();
    progress.start(format!("downloading churn {version}"));
    let bytes = match update::download(&url) {
        Ok(bytes) => bytes,
        Err(err) => {
            progress.stop("download failed");
            return Err(err);
        }
    };
    let checksum = match update::fetch_text(&checksum_url, Duration::from_secs(15)) {
        Ok(checksum) => checksum,
        Err(err) => {
            progress.stop("checksum download failed");
            return Err(err);
        }
    };
    let Some(expected) = update::parse_checksum(&checksum) else {
        progress.stop("checksum was invalid");
        return Err(io::Error::other(format!(
            "{checksum_url} did not contain a SHA-256 digest"
        )));
    };
    if !update::verify_sha256(&bytes, &expected) {
        progress.stop("checksum did not match");
        return Err(io::Error::other(format!(
            "the downloaded churn binary did not match {checksum_url}"
        )));
    }
    progress.stop(format!("churn {version} downloaded and verified"));

    update::replace_binary(&exe, &bytes)?;
    log::success(format!("churn updated to {version}"))?;
    Ok(exe)
}

fn update_dashboard(target_ref: &str, old_ref: &str, force: bool) -> io::Result<()> {
    let dir = Stack::Server.dir();
    let env_path = Stack::Server.env_path();

    if !system::docker_image_exists(target_ref) {
        let progress = spinner();
        progress.start(format!("checking {target_ref}"));
        if let Err(err) = system::docker_manifest_inspect(target_ref) {
            progress.stop("image is not published");
            return Err(err);
        }
        progress.stop(format!("{target_ref} is available"));
    }

    if force || !system::docker_image_exists(target_ref) {
        let progress = spinner();
        progress.start(format!("pulling {target_ref}"));
        let result = system::docker_pull(target_ref, &mut |line| {
            progress.set_message(console::truncate_str(line, 100, "…"));
        });
        match result {
            Ok(()) => progress.stop(format!("pulled {target_ref}")),
            Err(err) => {
                progress.stop("image pull failed");
                return Err(err);
            }
        }
    }

    assets::materialize(&envfile::root(), Stack::Server)?;
    envfile::upsert(&env_path, DASHBOARD_IMAGE_ENV, target_ref)?;

    let mut live = LiveLog::start("recreating the dashboard");
    match system::compose_recreate_service(&dir, DASHBOARD_SERVICE, &mut |line| live.push(line)) {
        Ok(()) => live.success("dashboard container recreated"),
        Err(err) => {
            live.error("dashboard recreation failed");
            if let Ok(logs) = system::compose_logs(&dir, DASHBOARD_SERVICE, 100)
                && !logs.trim().is_empty()
            {
                eprintln!("{logs}");
            }
            let rollback = rollback_dashboard(&dir, &env_path, old_ref);
            return Err(match rollback {
                Ok(()) => io::Error::other(format!("{err}; rolled back to {old_ref}")),
                Err(rollback_err) => io::Error::other(format!(
                    "{err}; rollback to {old_ref} also failed: {rollback_err}"
                )),
            });
        }
    }

    let port = dashboard_port();
    let progress = spinner();
    progress.start("waiting for the dashboard to answer");
    match wait_for_dashboard(port, Duration::from_secs(60)) {
        Ok(()) => {
            progress.stop("dashboard is healthy");
            Ok(())
        }
        Err(err) => {
            progress.stop("dashboard did not become healthy");
            if let Ok(logs) = system::compose_logs(&dir, DASHBOARD_SERVICE, 100)
                && !logs.trim().is_empty()
            {
                eprintln!("{logs}");
            }
            let rollback = rollback_dashboard(&dir, &env_path, old_ref);
            Err(match rollback {
                Ok(()) => io::Error::other(format!("{err}; rolled back to {old_ref}")),
                Err(rollback_err) => io::Error::other(format!(
                    "{err}; rollback to {old_ref} also failed: {rollback_err}"
                )),
            })
        }
    }
}

fn rollback_dashboard(dir: &Path, env_path: &Path, old_ref: &str) -> io::Result<()> {
    envfile::upsert(env_path, DASHBOARD_IMAGE_ENV, old_ref)?;
    let mut live = LiveLog::start(format!("restoring the dashboard to {old_ref}"));
    match system::compose_recreate_service(dir, DASHBOARD_SERVICE, &mut |line| live.push(line)) {
        Ok(()) => {
            live.success(format!("dashboard restored to {old_ref}"));
            Ok(())
        }
        Err(err) => {
            live.error("dashboard rollback failed");
            Err(err)
        }
    }
}

fn dashboard_port() -> u16 {
    envfile::read(&Stack::Server.env_path())
        .get(Port::Dashboard.env_key())
        .and_then(|value| ports::validate_port(value).ok())
        .unwrap_or_else(|| Port::Dashboard.default_port())
}

fn wait_for_dashboard(port: u16, timeout: Duration) -> io::Result<()> {
    let url = format!("http://127.0.0.1:{port}/api/health");
    let deadline = Instant::now() + timeout;
    loop {
        if ureq::get(&url)
            .timeout(Duration::from_secs(2))
            .call()
            .is_ok()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other(format!(
                "dashboard did not answer {url} within {}s",
                timeout.as_secs()
            )));
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}

/// Print the configured service URLs. This is read-only on purpose: unlike the
/// installer it does not require root, Docker or a TTY.
fn show_services(args: &Args) -> io::Result<()> {
    let root = envfile::root();
    let chosen = args.stacks.clone().unwrap_or_else(|| Stack::ALL.to_vec());
    if churn::show::installed(&root, &chosen).is_empty() {
        println!("no churn services are installed under {}", root.display());
        return Ok(());
    }
    let host = churn::show::host_ip(&root);
    for service in churn::show::services(&root, &chosen, &host) {
        println!("{:<14} {}", service.name, service.url);
    }
    Ok(())
}

/// Returns `false` when a preflight check stopped the installer.
fn run(args: Args) -> io::Result<bool> {
    if args.uninstall {
        return uninstall(args);
    }

    intro("churn · torrent stack installer")?;

    if !ensure_root()? || !ensure_docker()? {
        return Ok(false);
    }

    let chosen = choose_stacks(&args)?;
    let existing_ports = preflight(&chosen)?;
    let questions = stack::collect_questions(&chosen);
    let answers = ask_questions(&questions, args.yes, &existing_ports)?;
    ensure_data_dir(&answers)?;
    show_plan(&chosen, &questions, &answers)?;

    if !args.yes
        && !confirm(if args.dry_run {
            "Write these files?"
        } else {
            "Write these files and start the services?"
        })
        .initial_value(true)
        .interact()?
    {
        outro_cancel("cancelled — nothing written")?;
        return Ok(true);
    }

    write_stacks(&chosen, &answers, args.dry_run)?;
    start_stacks(&chosen, args.dry_run)?;
    if chosen.contains(&Stack::Server) {
        setup_jellyfin(args.dry_run)?;
    }

    let mut steps = String::new();
    for stack in &chosen {
        steps.push_str(&format!("{}\n", stack.key()));
        for step in stack.next_steps(&answers) {
            steps.push_str(&format!("  {step}\n"));
        }
    }
    outro_note("Next steps", steps.trim_end().to_string())?;
    if args.dry_run {
        outro("dry run complete — no files written, services not started")?;
    } else {
        outro("done")?;
    }
    Ok(true)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(args) => args,
        Err(message) => {
            eprintln!("churn: {message}\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    if args.help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    if args.show {
        return match show_services(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("churn: {err}");
                ExitCode::FAILURE
            }
        };
    }
    if args.update {
        if args.check {
            return match update_check(&args) {
                Ok(true) => ExitCode::SUCCESS,
                Ok(false) => ExitCode::from(1),
                Err(err) => {
                    eprintln!("churn: {err}");
                    ExitCode::FAILURE
                }
            };
        }
        return match update_host(&args) {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("churn: {err}");
                ExitCode::FAILURE
            }
        };
    }

    if args.migrate {
        return match migrate_storage(&args) {
            Ok(true) => ExitCode::SUCCESS,
            Ok(false) => ExitCode::FAILURE,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {
                let _ = outro_cancel("cancelled — nothing copied");
                ExitCode::from(130)
            }
            Err(err) => {
                let _ = outro_cancel(format!("failed: {err}"));
                ExitCode::FAILURE
            }
        };
    }

    match run(args) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(err) if err.kind() == io::ErrorKind::Interrupted => {
            let _ = outro_cancel("cancelled — nothing written");
            ExitCode::from(130)
        }
        Err(err) => {
            let _ = outro_cancel(format!("failed: {err}"));
            ExitCode::FAILURE
        }
    }
}
