//! The non-interactive paths: answer resolution and the prompt the LLM reads.
//!
//! These tests exist because a scripted install is only as good as its failure
//! modes. A missing answer must stop before anything is written, and
//! `llm-install` must never teach an agent to do something churn's own code does
//! differently.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use churn::answers::{self, Unresolved};
use churn::ports::Port;
use churn::question::Question;
use churn::stack::{self, Answers, Stack};
use churn::vpn::VpnProvider;

const MULLVAD_KEY: &str = "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=";

fn temp_dir(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "churn-noninteractive-{label}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("temp dir");
    dir
}

fn storage(root: &Path) -> (String, String) {
    let download = root.join("data");
    let media = download.join("media");
    fs::create_dir_all(&media).expect("storage dirs");
    (
        download.to_string_lossy().into_owned(),
        media.to_string_lossy().into_owned(),
    )
}

fn supplied(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn complete_answers(root: &Path, extra: &[(&str, &str)]) -> HashMap<String, String> {
    let (download, media) = storage(root);
    let mut base = vec![
        ("DOWNLOAD_DIR", download.as_str()),
        ("MEDIA_DIR", media.as_str()),
        ("VPN_SERVICE_PROVIDER", "mullvad"),
        ("WIREGUARD_PRIVATE_KEY", MULLVAD_KEY),
        ("WIREGUARD_ADDRESSES", "10.64.0.2/32"),
    ];
    base.extend_from_slice(extra);
    supplied(&base)
}

#[test]
fn the_resolver_covers_every_question_the_wizard_asks() {
    // The set of questions `collect_questions` produces is what the interactive
    // wizard would have asked. The resolver must answer all of them, or a
    // scripted install would silently fall back to `Stack::apply`'s defaults.
    let root = temp_dir("covers-every-question");
    let questions = stack::collect_questions(&[Stack::Server, Stack::Torrent]);
    let answers = answers::resolve(&Answers::new(), &complete_answers(&root, &[]))
        .expect("complete answers resolve");

    for question in questions {
        // WireguardAddresses is only required by providers that need it, and
        // OpenVPN answers only by PIA — all four protocols still have to be
        // represented for whichever provider was chosen.
        assert!(
            answers.contains_key(&question)
                || matches!(
                    question,
                    Question::WireguardAddresses
                        | Question::OpenvpnUser
                        | Question::OpenvpnPassword
                ),
            "{question:?} was not answered by the non-interactive resolver"
        );
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn every_stack_gets_the_answers_it_needs_to_apply_itself() {
    // `Stack::apply` reads ports and storage out of the same map. A missing port
    // there means the generated .env silently keeps the old default.
    let root = temp_dir("every-stack-applies");
    let answers = answers::resolve(&Answers::new(), &complete_answers(&root, &[]))
        .expect("complete answers resolve");

    for stack in Stack::ALL {
        for question in stack.questions() {
            match question {
                Question::Port(port) => assert!(
                    answers.contains_key(&Question::Port(*port)),
                    "{} is missing for {}",
                    port.env_key(),
                    stack.key()
                ),
                Question::WireguardAddresses
                | Question::OpenvpnUser
                | Question::OpenvpnPassword => {}
                other => assert!(
                    answers.contains_key(other),
                    "{other:?} is missing for {}",
                    stack.key()
                ),
            }
        }
    }
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_missing_answer_exits_two_before_anything_is_written() {
    // The real binary, no TTY on stdin/stdout, no answers: it must refuse with
    // exit 2 and name the key instead of dying on the first prompt.
    let root = temp_dir("missing-answer");
    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args(["--stacks", "server", "--non-interactive"])
        .env("CHURN_ROOT", &root)
        // Clear anything the developer's shell might have exported.
        .env_remove("DOWNLOAD_DIR")
        .env_remove("MEDIA_DIR")
        .env_remove("VPN_SERVICE_PROVIDER")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("churn runs");

    assert_eq!(
        output.status.code(),
        Some(2),
        "a missing answer must exit 2; stderr was:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("DOWNLOAD_DIR"), "{stderr}");
    assert!(stderr.contains("MEDIA_DIR"), "{stderr}");
    assert!(
        !root.join("server").exists(),
        "nothing may be written when answers are missing"
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn non_interactive_without_stacks_is_a_usage_error() {
    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args(["--non-interactive"])
        .stdin(std::process::Stdio::null())
        .output()
        .expect("churn runs");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--stacks"), "{stderr}");
}

#[test]
fn an_readable_answers_file_is_refused() {
    let root = temp_dir("loose-answers");
    let path = root.join("answers.env");
    fs::write(
        &path,
        "DOWNLOAD_DIR=/tmp\nMEDIA_DIR=/tmp/media\nVPN_SERVICE_PROVIDER=mullvad\n",
    )
    .unwrap();
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args([
            "--stacks",
            "server",
            "--non-interactive",
            "--answers",
            path.to_str().unwrap(),
        ])
        .env("CHURN_ROOT", &root)
        .stdin(std::process::Stdio::null())
        .output()
        .expect("churn runs");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("chmod 600"), "{stderr}");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn the_answers_file_supplies_secrets_without_argv() {
    // End-to-end proof that a secret can arrive through the file: the install is
    // scripted, so it gets past resolution and fails later for a reason that is
    // not "missing WIREGUARD_PRIVATE_KEY".
    let root = temp_dir("answers-file");
    let (download, media) = storage(&root);
    let path = root.join("answers.env");
    fs::write(
        &path,
        format!(
            "DOWNLOAD_DIR={download}\n\
             MEDIA_DIR={media}\n\
             VPN_SERVICE_PROVIDER=mullvad\n\
             WIREGUARD_PRIVATE_KEY={MULLVAD_KEY}\n\
             WIREGUARD_ADDRESSES=10.64.0.2/32\n"
        ),
    )
    .unwrap();
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args([
            "--stacks",
            "server,torrent",
            "--non-interactive",
            "--dry-run",
            "--answers",
            path.to_str().unwrap(),
        ])
        .env("CHURN_ROOT", &root)
        .env_remove("WIREGUARD_PRIVATE_KEY")
        .env_remove("DOWNLOAD_DIR")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("churn runs");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !stderr.contains("is still missing"),
        "the answers file should have satisfied the resolver:\n{stderr}"
    );
    assert!(
        !stderr.contains(MULLVAD_KEY),
        "a secret must never be echoed:\n{stderr}"
    );
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn llm_install_prints_a_prompt_and_writes_nothing() {
    let root = temp_dir("llm-install");
    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args(["llm-install", "--stacks", "server,torrent"])
        .env("CHURN_ROOT", &root)
        .output()
        .expect("churn runs");
    assert!(output.status.success(), "{:?}", output.status);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("--non-interactive"), "prompt missing");
    assert!(stdout.contains("Confirm the plan"), "prompt missing");
    assert!(
        stdout.contains("Discover, don't ask"),
        "prompt missing the discovery section"
    );
    // Read-only: no stack directory was created.
    assert!(!root.join("server").exists());
    assert!(!root.join("torrent").exists());
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn llm_install_json_is_one_parseable_object() {
    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args(["llm-install", "--format", "json"])
        .output()
        .expect("churn runs");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: serde_json::Value = serde_json::from_str(stdout.trim()).expect("valid JSON");
    assert_eq!(parsed["command"], "llm-install");
    let prompt = parsed["prompt"].as_str().expect("prompt is a string");
    assert!(prompt.contains("--non-interactive"));
}

#[test]
fn the_prompt_teaches_the_same_provider_rules_the_installer_enforces() {
    // If a provider gains credentials or a protocol, the prompt must follow.
    // This is what makes the command "self-updating" rather than a stale doc.
    let prompt = churn::llm::markdown(&Stack::ALL, "0.0.0", "HELP");
    for provider in VpnProvider::ALL {
        assert!(
            prompt.contains(provider.gluetun_id()),
            "{} missing from the prompt",
            provider.gluetun_id()
        );
        for key in provider.required_env() {
            assert!(prompt.contains(key), "{key} missing from the prompt");
        }
    }
    // Ports stay churn's job.
    for port in Port::ALL {
        assert!(
            !prompt.contains(&format!("{}=", port.env_key())),
            "{} must not be suggested",
            port.env_key()
        );
    }
}

#[test]
fn the_unresolved_message_names_only_the_keys_that_are_missing() {
    let err = answers::resolve(
        &Answers::new(),
        &supplied(&[("VPN_SERVICE_PROVIDER", "mullvad")]),
    )
    .expect_err("nothing supplied");
    let Unresolved::Missing(keys) = &err else {
        panic!("expected missing keys, got {err}");
    };
    let message = err.message();
    for key in keys {
        assert!(message.contains(key), "{key} must be named");
    }
    assert!(
        !message.contains("JELLYFIN"),
        "unrelated keys must not appear"
    );
}

#[test]
fn a_dry_run_writes_no_directories() {
    // `--dry-run` promises "no files written"; creating the storage directories
    // is a write like any other, and it used to happen before the flag was read.
    let root = temp_dir("dry-run-dirs");
    let download = root.join("data");
    let media = root.join("library");
    let path = root.join("answers.env");
    fs::write(
        &path,
        format!(
            "DOWNLOAD_DIR={}\nMEDIA_DIR={}\nVPN_SERVICE_PROVIDER=mullvad\n\
             WIREGUARD_PRIVATE_KEY={MULLVAD_KEY}\nWIREGUARD_ADDRESSES=10.64.0.2/32\n",
            download.display(),
            media.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_churn"))
        .args([
            "--stacks",
            "server,torrent",
            "--non-interactive",
            "--dry-run",
            "--answers",
            path.to_str().unwrap(),
        ])
        .env("CHURN_ROOT", &root)
        .env_remove("DOWNLOAD_DIR")
        .env_remove("MEDIA_DIR")
        .stdin(std::process::Stdio::null())
        .output()
        .expect("churn runs");

    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !download.exists(),
        "dry run created {}\n{stderr}",
        download.display()
    );
    assert!(
        !media.exists(),
        "dry run created {}\n{stderr}",
        media.display()
    );
    assert!(!root.join("server/.env").exists(), "dry run wrote .env");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_written_env_file_is_owner_only() {
    // Both stacks' `.env` hold a secret: the WireGuard private key in torrent,
    // the Jellyfin admin password in server. A fresh file must not inherit the
    // umask's 0644.
    use std::os::unix::fs::PermissionsExt;
    let root = temp_dir("env-mode");
    for stack in Stack::ALL {
        let path = root.join(stack.key()).join(".env");
        churn::envfile::write_merged(&path, &[("WIREGUARD_PRIVATE_KEY", MULLVAD_KEY.to_string())])
            .unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{stack:?} .env is {mode:o}, not 0600");
    }
    fs::remove_dir_all(&root).unwrap();
}
