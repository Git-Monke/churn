//! The dashboard container runs as `PUID:PGID` and reads `server/.env`, so the
//! generated file must be group-readable without becoming writable by that
//! group: compose interpolates its values as root. The torrent file holds the
//! WireGuard key and must stay owner-only.

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

use churn::question::Question;
use churn::stack::{Answers, Stack};

fn temp_root(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "churn-env-permissions-{}-{label}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("media")).unwrap();
    fs::create_dir_all(dir.join("downloads")).unwrap();
    dir
}

fn answers(root: &Path) -> Answers {
    let mut answers = Answers::new();
    answers.insert(
        Question::DownloadDir,
        root.join("downloads").to_string_lossy().into_owned(),
    );
    answers.insert(
        Question::MediaDir,
        root.join("media").to_string_lossy().into_owned(),
    );
    answers
}

#[test]
fn the_server_env_is_group_readable_but_the_torrent_env_is_owner_only() {
    let root = temp_root("stacks");
    // `Stack::dir` resolves through `CHURN_ROOT`; this is the only test in this
    // binary, so the process-wide variable cannot race another test.
    unsafe { std::env::set_var("CHURN_ROOT", &root) };

    let server = Stack::Server.apply(&answers(&root)).unwrap();
    let server_mode = fs::metadata(&server).unwrap();
    assert_eq!(
        server_mode.permissions().mode() & 0o777,
        0o640,
        "the dashboard's group must be able to read server/.env"
    );
    assert_eq!(
        (server_mode.uid(), server_mode.gid()),
        owner(&root.join("media")),
        "server/.env must keep its owner and use the containers' group"
    );

    let torrent = Stack::Torrent.apply(&answers(&root)).unwrap();
    assert_eq!(
        fs::metadata(&torrent).unwrap().permissions().mode() & 0o777,
        0o600,
        "torrent/.env holds the WireGuard key and must stay private"
    );

    fs::remove_dir_all(root).unwrap();
}

/// Owning uid/gid of a path, read straight from the metadata.
fn owner(path: &Path) -> (u32, u32) {
    let meta = fs::metadata(path).unwrap();
    (meta.uid(), meta.gid())
}
