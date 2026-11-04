//! churn — interactive installer for the torrent/media stack.
//!
//! Pick which machines' roles to set up; the questions each stack needs are
//! collected once and shared, so selecting both `server` and `torrent` asks for
//! the media path a single time.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use cliclack::{
    confirm, input, intro, log, multiselect, note, outro, outro_cancel, outro_note, password,
    spinner,
};

use churn::assets;
use churn::envfile;
use churn::jellyfin::{self, Credentials, Jellyfin};
use churn::live::LiveLog;
use churn::mullvad;
use churn::ports::{self, Port};
use churn::question::{Question, Section};
use churn::stack::{self, Answers, Stack};
use churn::system;

const HELP: &str = "\
churn — installer for the torrent/media stack

Must be run as root (for example: sudo churn). If Docker is missing, churn
offers to install it for the detected Linux distribution. After writing each
stack's .env, it starts the stack with docker compose up -d and completes Jellyfin
first-run setup, writing a generated API key to server/.env. Use --uninstall to
stop/remove the containers and delete generated config without touching DATA_DIR.

USAGE:
    churn [OPTIONS]

OPTIONS:
    --stacks <LIST>   comma separated: server,torrent (skips the menu; with
                      --uninstall, limits what is removed)
    --uninstall       stop and remove the stack containers, then delete their
                      generated config, cache and .env files; DATA_DIR is kept
    --dry-run         show the plan; write, remove and start nothing
    -y, --yes         skip the final confirmation
    -h, --help        show this help";

#[derive(Default)]
struct Args {
    stacks: Option<Vec<Stack>>,
    uninstall: bool,
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
            "--uninstall" => args.uninstall = true,
            "--dry-run" => args.dry_run = true,
            "-y" | "--yes" => args.yes = true,
            "-h" | "--help" => args.help = true,
            other if other.starts_with("--stacks=") => {
                args.stacks = Some(parse_stack_list(&other["--stacks=".len()..])?);
            }
            other => return Err(format!("unknown option {other:?}")),
        }
    }
    Ok(args)
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

fn preflight(chosen: &[Stack]) -> io::Result<()> {
    let findings: Vec<String> = chosen.iter().flat_map(|stack| stack.preflight()).collect();
    for finding in &findings {
        log::warning(finding)?;
    }
    if findings.is_empty() {
        log::success("host prerequisites look fine")?;
    }
    Ok(())
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
        "\nDATA_DIR, media, downloads and images are left untouched.\nThe dashboard cache volume is removed.",
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
    preflight(&chosen)?;
    let questions = stack::collect_questions(&chosen);
    let answers = ask_questions(&questions, args.yes)?;
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
