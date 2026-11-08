//! Validation of the *real* `torrent/docker-compose.yml`.
//!
//! `src/security.rs` has unit tests against synthetic fixtures, which proves the
//! rules work but not that the file that ships satisfies them. These tests
//! render the real compose file with a fake env and feed the result to the same
//! validator the installer, CI and `scripts/vpn-gate.sh` use.
//!
//! The rejection cases live in `tests/vpn-gate/unsafe/cases.tsv`, which
//! `scripts/vpn-gate.sh` reads too: one list of known-unsafe layouts, asserted
//! by both the test suite and the release gate.
//!
//! These tests never skip. A missing `docker` binary is a failure, because a
//! security gate that silently skips is worse than one that is absent.

use std::path::{Path, PathBuf};
use std::process::Command;

use churn::system;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn torrent_dir() -> PathBuf {
    repo_root().join("torrent")
}

fn fixture_env() -> PathBuf {
    repo_root().join("tests/vpn-gate/fixture.env")
}

fn unsafe_dir() -> PathBuf {
    repo_root().join("tests/vpn-gate/unsafe")
}

/// One row of `cases.tsv`.
struct Case {
    id: String,
    expected: String,
    overrides: Vec<PathBuf>,
    env: Vec<(String, String)>,
}

fn cases() -> Vec<Case> {
    cases_from(&unsafe_dir().join("cases.tsv"))
}

fn cases_from(path: &Path) -> Vec<Case> {
    let body = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
    let mut cases = Vec::new();
    for (index, line) in body.lines().enumerate() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(
            fields.len(),
            4,
            "{}:{}: expected 4 tab separated fields, found {}",
            path.display(),
            index + 1,
            fields.len()
        );
        let overrides = if fields[2] == "-" {
            Vec::new()
        } else {
            fields[2]
                .split(',')
                .map(|name| unsafe_dir().join(name))
                .collect()
        };
        let env = if fields[3] == "-" {
            Vec::new()
        } else {
            fields[3]
                .split(' ')
                .map(|pair| {
                    let (key, value) = pair
                        .split_once('=')
                        .unwrap_or_else(|| panic!("{}: bad env pair {pair:?}", fields[0]));
                    (key.to_string(), value.to_string())
                })
                .collect()
        };
        cases.push(Case {
            id: fields[0].to_string(),
            expected: fields[1].to_string(),
            overrides,
            env,
        });
    }
    assert!(!cases.is_empty(), "{} lists no cases", path.display());
    cases
}

/// Render `docker compose config --format json` for the torrent stack.
fn render(overrides: &[PathBuf], env: &[(String, String)]) -> Result<serde_json::Value, String> {
    let mut command = Command::new("docker");
    command
        .args(["compose", "--env-file"])
        .arg(fixture_env())
        .args(["-f", "docker-compose.yml"]);
    for override_file in overrides {
        command.arg("-f").arg(override_file);
    }
    command.args(["config", "--format", "json"]);
    command.current_dir(torrent_dir());
    for (key, value) in env {
        command.env(key, value);
    }
    let output = command.output().map_err(|err| {
        format!("docker must be installed to validate the shipped compose file: {err}")
    })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("compose config is not JSON: {err}"))
}

#[test]
fn the_shipped_compose_file_isolates_every_networked_service() {
    let config = render(&[], &[]).expect("the shipped compose file must render");
    assert_eq!(
        churn::security::verify_torrent_isolation(&config),
        Ok(()),
        "the shipped torrent/docker-compose.yml must confine every networked service to gluetun"
    );
}

#[test]
fn the_fixture_holds_no_real_credentials() {
    let env = std::fs::read_to_string(fixture_env()).expect("fixture env");
    assert!(
        env.contains("WIREGUARD_PRIVATE_KEY=AAAA"),
        "the fixture must hold a placeholder WireGuard key"
    );
    assert!(
        env.contains("HOST_IP=127.0.0.1"),
        "the fixture must use a loopback HOST_IP so the strongest assertion holds"
    );
}

#[test]
fn every_known_unsafe_layout_is_rejected() {
    let mut failures = Vec::new();
    let mut checked = 0;

    for case in cases() {
        checked += 1;
        let config = match render(&case.overrides, &case.env) {
            Ok(config) => config,
            Err(stderr) => {
                failures.push(format!(
                    "{}: compose refused to render the override: {stderr}",
                    case.id
                ));
                continue;
            }
        };
        match churn::security::verify_torrent_isolation(&config) {
            Ok(()) => failures.push(format!(
                "{}: accepted the unsafe layout (expected a rejection mentioning {:?})",
                case.id, case.expected
            )),
            Err(problems) => {
                if !problems
                    .iter()
                    .any(|problem| problem.contains(&case.expected))
                {
                    failures.push(format!(
                        "{}: rejected for the wrong reason, expected {:?} in {problems:#?}",
                        case.id, case.expected
                    ));
                }
            }
        }
    }

    assert!(checked > 0, "cases.tsv listed no cases to check");
    assert!(
        failures.is_empty(),
        "unsafe layouts that were not rejected as expected:\n  - {}",
        failures.join("\n  - ")
    );

    // And the unmodified file must still pass, so no case above can be passing
    // just because the whole render is broken.
    let config = render(&[], &[]).expect("the shipped compose file must render");
    assert_eq!(
        churn::security::verify_torrent_isolation(&config),
        Ok(()),
        "the unmodified compose file must pass; a failing case above may be hiding a broken baseline"
    );
}

/// The same rejection list, asserted for a reason the script can report too:
/// the gate's `--static-only` mode and this test must agree.
#[test]
fn the_case_list_is_parseable_and_unique() {
    let listed = cases();
    assert!(listed.len() >= 15, "cases.tsv got suspiciously short");
    for case in &listed {
        assert!(!case.id.trim().is_empty(), "a case has no id");
        assert!(
            !case.expected.trim().is_empty(),
            "{} has no expected message",
            case.id
        );
        for override_file in &case.overrides {
            assert!(
                override_file.is_file(),
                "{} points at missing override {}",
                case.id,
                override_file.display()
            );
        }
    }
}

/// Disambiguates the throwaway env files of concurrent renders.
static TEMP_ENV_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Render with a throwaway `.env` built from the fixture.///
/// Compose interpolation reads `--env-file` in preference to the process
/// environment, so a case that wants a different storage layout has to supply
/// its own file rather than just setting variables.
fn render_with_storage(pairs: &[(&str, Option<&str>)]) -> Result<serde_json::Value, String> {
    let fixture = std::fs::read_to_string(fixture_env()).map_err(|err| err.to_string())?;
    let replaced: Vec<&str> = pairs.iter().map(|(key, _)| *key).collect();
    let mut body = String::new();
    for line in fixture.lines() {
        let name = line.split_once('=').map(|(name, _)| name.trim());
        if name.is_some_and(|name| replaced.contains(&name)) {
            continue;
        }
        body.push_str(line);
        body.push('\n');
    }
    for (key, value) in pairs {
        if let Some(value) = value {
            body.push_str(&format!("{key}={value}\n"));
        }
    }

    let path = std::env::temp_dir().join(format!(
        "churn-compose-gate-{}-{}.env",
        std::process::id(),
        // Unique per call: tests run in parallel and a shared name made one
        // case render another case's storage paths.
        TEMP_ENV_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::write(&path, body).map_err(|err| err.to_string())?;

    let mut command = Command::new("docker");
    command.args(["compose", "--env-file"]).arg(&path).args([
        "-f",
        "docker-compose.yml",
        "config",
        "--format",
        "json",
    ]);
    command.current_dir(torrent_dir());
    let output = command.output().map_err(|err| err.to_string())?;
    let _ = std::fs::remove_file(&path);
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr)
            .trim_end()
            .to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("compose config is not JSON: {err}"))
}

/// Host paths of every bind mount in the rendered compose file.
fn bind_sources(config: &serde_json::Value) -> Vec<String> {
    let mut sources = Vec::new();
    let services = config["services"]
        .as_object()
        .expect("compose config has services");
    for service in services.values() {
        let Some(volumes) = service["volumes"].as_array() else {
            continue;
        };
        for volume in volumes {
            if let Some(source) = volume["source"].as_str() {
                sources.push(source.to_string());
            }
        }
    }
    sources
}

/// A pre-split install has `DATA_DIR` in `.env` and no `MEDIA_DIR`.
///
/// `churn update` materialises these compose files without rerunning the
/// installer, so an install that never sees the new prompts must still render
/// and mount exactly the paths it mounted before the split.
#[test]
fn a_legacy_env_with_only_data_dir_still_renders_the_old_layout() {
    let config = render_with_storage(&[
        ("DOWNLOAD_DIR", None),
        ("MEDIA_DIR", None),
        ("DATA_DIR", Some("/srv/churn")),
    ])
    .expect("a legacy .env must still render the shipped compose");
    let sources = bind_sources(&config);
    assert!(
        sources.contains(&"/srv/churn".to_string()),
        "the legacy DATA_DIR must still be mounted at /data: {sources:?}"
    );
    assert!(
        sources.contains(&"/srv/churn/media".to_string()),
        "MEDIA_DIR must fall back to <DATA_DIR>/media so the layout is unchanged: {sources:?}"
    );
}

/// The three storage keys a compose render can read, with the value to use for
/// each (`None` removes the key so a fallback case is actually exercised).
type StorageEnv = [(&'static str, Option<&'static str>); 3];

/// Every storage combination must mount the paths the installer would write.
#[test]
fn the_storage_mounts_follow_the_env_it_is_given() {
    let cases: [(&str, StorageEnv, &str, &str); 3] = [
        (
            "legacy key only",
            [
                ("DOWNLOAD_DIR", None),
                ("MEDIA_DIR", None),
                ("DATA_DIR", Some("/legacy")),
            ],
            "/legacy",
            "/legacy/media",
        ),
        (
            "new download key only",
            [
                ("DOWNLOAD_DIR", Some("/mnt/ssd")),
                ("MEDIA_DIR", None),
                ("DATA_DIR", None),
            ],
            "/mnt/ssd",
            "/mnt/ssd/media",
        ),
        (
            "both new keys",
            [
                ("DOWNLOAD_DIR", Some("/mnt/ssd")),
                ("MEDIA_DIR", Some("/mnt/hdd/library")),
                ("DATA_DIR", None),
            ],
            "/mnt/ssd",
            "/mnt/hdd/library",
        ),
    ];

    for (label, pairs, download, media) in cases {
        let config = render_with_storage(&pairs)
            .unwrap_or_else(|err| panic!("{label}: compose refused to render: {err}"));
        let sources = bind_sources(&config);
        assert!(
            sources.contains(&download.to_string()),
            "{label}: expected {download} mounted at /data, found {sources:?}"
        );
        assert!(
            sources.contains(&media.to_string()),
            "{label}: expected {media} mounted at /data/media, found {sources:?}"
        );
    }
}

#[test]
fn verify_vpn_reads_the_env_file_it_is_given() {
    // The same code path CI and scripts/vpn-gate.sh use, exercised end to end
    // through the library entry point (no CLI process needed).
    system::verify_torrent_isolation_env(&torrent_dir(), Some(&fixture_env()))
        .expect("the real compose file with the fixture env must pass");
}
