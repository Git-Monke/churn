//! Every service-owned bind-mount source must have a matching entry in
//! [`churn::stack::Stack::config_dirs`].
//!
//! Churn creates and owns those directories before `compose up`; if a new
//! `./config/...` (or `./cache/...`) mount is added to a compose file without a
//! matching entry, Docker would auto-create it as `root:root` and the container
//! (running as `PUID:PGID`) could not write there — the exact `/config/log`
//! failure this guards against. Cross-checking the real files keeps the list
//! honest without a hand-maintained duplicate.

use std::collections::BTreeSet;
use std::path::PathBuf;

use churn::stack::Stack;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Bind-mount sources of the form `./config/<name>` or `./cache/<name>` in a
/// stack's compose file, as the path relative to the stack root.
///
/// Named volumes and the `./config` directory itself (the dashboard's read-only
/// `/app/config`) are ignored: only the per-service trees are churn's to own.
fn declared_config_dirs(stack: Stack) -> BTreeSet<String> {
    let path = repo_root().join(stack.key()).join("docker-compose.yml");
    let body = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("cannot read {}: {err}", path.display()));
    let mut found = BTreeSet::new();
    for line in body.lines() {
        let Some(rest) = line.trim_start().strip_prefix("- ./") else {
            continue;
        };
        let Some((source, _)) = rest.split_once(':') else {
            continue;
        };
        if source.starts_with("config/") || source.starts_with("cache/") {
            found.insert(source.to_string());
        }
    }
    found
}

#[test]
fn every_config_bind_mount_has_a_prepared_directory() {
    for stack in Stack::ALL {
        let declared = declared_config_dirs(stack);
        let prepared: BTreeSet<String> = stack
            .config_dirs()
            .iter()
            .map(|dir| dir.to_string())
            .collect();
        assert_eq!(
            declared,
            prepared,
            "{}: docker-compose.yml bind mounts and Stack::config_dirs() drifted; \
             add the new directory to config_dirs() so churn creates and owns it",
            stack.key()
        );
    }
}
