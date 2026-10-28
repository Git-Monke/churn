//! churn — interactive installer for the torrent/media stack.
//!
//! Pick which machines' roles to set up; the questions each stack needs are
//! collected once and shared, so selecting both `server` and `torrent` asks for
//! the media path a single time.

use std::collections::HashMap;
use std::io;
use std::path::Path;
use std::process::ExitCode;

use cliclack::{confirm, intro, log, multiselect, note, outro, outro_cancel, outro_note, spinner};

use churn::question::{Question, Section};
use churn::stack::{self, Answers, Stack};
use churn::system;

const HELP: &str = "\
churn — installer for the torrent/media stack

Must be run as root (for example: sudo churn). If Docker is missing, churn
offers to install it for the detected Linux distribution.

USAGE:
    churn [OPTIONS]

OPTIONS:
    --stacks <LIST>   comma separated: server,torrent (skips the menu)
    --dry-run         collect answers, write nothing
    -y, --yes         skip the final confirmation
    -h, --help        show this help";

#[derive(Default)]
struct Args {
    stacks: Option<Vec<Stack>>,
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
    if let Some(explicit) = &args.stacks {
        return Ok(explicit.clone());
    }
    let mut prompt = multiselect::<Stack>("Which installers should this machine run?");
    for stack in Stack::ALL {
        prompt = prompt.item(stack, stack.key(), stack.description());
    }
    prompt.interact()
}

fn ask_questions(questions: &[Question]) -> std::io::Result<HashMap<Question, String>> {
    // Values from *any* stack's existing .env: a torrent-only rerun should reuse
    // the media path the server installer already chose on this machine.
    let mut defaults: HashMap<Question, String> = HashMap::new();
    for stack in Stack::ALL {
        for (question, value) in stack.stored_answers() {
            defaults.entry(question).or_insert(value);
        }
    }
    let stored = |question: &Question| defaults.get(question).map(String::as_str);

    let mut answers = Answers::new();
    let mut current = None;
    for question in questions {
        let section = question.section();
        if current != Some(section) {
            explain(section);
            current = Some(section);
        }
        answers.insert(*question, question.ask(stored(question))?);
    }
    Ok(answers)
}

fn explain(section: Section) {
    match section {
        Section::Vpn => {
            let _ = note(
                "Where to get these",
                "mullvad.net → Account → WireGuard config → download zip\n\
                 Open any .json inside it:\n\n\
                 PrivateKey  →  WireGuard private key\n\
                 Address     →  interface address, IPv4 entry with /32\n\n\
                 The key is written only to torrent/.env, which is gitignored.",
            );
        }
        Section::Storage => {
            let _ = note(
                "Storage layout",
                "One absolute host path holds media and downloads.\n\
                 It is mounted at /data inside every container, so Jellyfin and\n\
                 qBittorrent agree on paths no matter where they run.",
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
    for question in questions {
        if let Some(value) = stack::summary(*question, answers) {
            lines.push_str(&format!("{:<30} {value}\n", question.label()));
        }
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

fn write_stacks(chosen: &[Stack], answers: &Answers, dry_run: bool) -> io::Result<()> {
    let progress = spinner();
    for (index, stack) in chosen.iter().enumerate() {
        progress.start(format!(
            "[{}/{}] writing {}",
            index + 1,
            chosen.len(),
            stack.key()
        ));
        if dry_run {
            progress.stop(format!("would write {}", stack.env_path().display()));
            continue;
        }
        let path = stack.apply(answers)?;
        progress.stop(format!("wrote {}", path.display()));
    }
    Ok(())
}

/// Returns `false` when a preflight check stopped the installer.
fn run(args: Args) -> io::Result<bool> {
    intro("churn · torrent stack installer")?;

    if !ensure_root()? || !ensure_docker()? {
        return Ok(false);
    }

    let chosen = choose_stacks(&args)?;
    preflight(&chosen)?;
    let questions = stack::collect_questions(&chosen);
    let answers = ask_questions(&questions)?;
    ensure_data_dir(&answers)?;
    show_plan(&chosen, &questions, &answers)?;

    if !args.yes
        && !confirm("Write these files?")
            .initial_value(true)
            .interact()?
    {
        outro_cancel("cancelled — nothing written")?;
        return Ok(true);
    }

    write_stacks(&chosen, &answers, args.dry_run)?;

    let mut steps = String::new();
    for stack in &chosen {
        steps.push_str(&format!("{}\n", stack.key()));
        for step in stack.next_steps() {
            steps.push_str(&format!("  {step}\n"));
        }
    }
    outro_note("Next steps", steps.trim_end().to_string())?;
    if args.dry_run {
        outro("dry run complete — no files written")?;
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
