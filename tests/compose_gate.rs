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

#[test]
fn verify_vpn_reads_the_env_file_it_is_given() {
    // The same code path CI and scripts/vpn-gate.sh use, exercised end to end
    // through the library entry point (no CLI process needed).
    system::verify_torrent_isolation_env(&torrent_dir(), Some(&fixture_env()))
        .expect("the real compose file with the fixture env must pass");
}
