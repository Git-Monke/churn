//! Release lookup and the self-update primitives used by `churn update`.
//!
//! The CLI binary and the dashboard image share the same release version. This
//! module keeps the version/asset parsing pure so the network and filesystem
//! steps in `main.rs` stay small and testable.

use std::fs;
use std::io::{self, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::stack::DASHBOARD_IMAGE_REPO;

pub const REPO: &str = "git-monke/churn";
const LATEST_RELEASE_URL: &str = "https://api.github.com/repos/git-monke/churn/releases/latest";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/git-monke/churn/releases/download";
const USER_AGENT: &str = concat!("churn/", env!("CARGO_PKG_VERSION"));
const MAX_DOWNLOAD_BYTES: u64 = 64 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Release {
    pub version: String,
    pub url: String,
}

#[derive(Deserialize)]
struct LatestRelease {
    tag_name: String,
    #[serde(default)]
    html_url: String,
}

/// Parse the GitHub `releases/latest` response into a normalized release.
pub fn parse_latest_release(body: &str) -> io::Result<Release> {
    let release: LatestRelease = serde_json::from_str(body)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    let version = normalize_version(&release.tag_name).map_err(io::Error::other)?;
    Ok(Release {
        version,
        url: release.html_url,
    })
}

/// Accept `0.1.4` or `v0.1.4` and reject channels and pre-releases.
pub fn normalize_version(value: &str) -> Result<String, String> {
    let value = value.trim().strip_prefix('v').unwrap_or(value.trim());
    let parts: Vec<&str> = value.split('.').collect();
    if parts.len() != 3 {
        return Err(format!("expected a version like 0.1.4, got {value:?}"));
    }
    for part in &parts {
        if part.is_empty()
            || !part.chars().all(|ch| ch.is_ascii_digit())
            || (part.len() > 1 && part.starts_with('0'))
        {
            return Err(format!("expected a version like 0.1.4, got {value:?}"));
        }
    }
    Ok(parts.join("."))
}

/// The dashboard image reference for a release version.
pub fn image_ref(version: &str) -> String {
    format!("{DASHBOARD_IMAGE_REPO}:{version}")
}

/// Last path component of an image reference, ignoring registry ports.
pub fn image_tag(image: &str) -> Option<&str> {
    let image = image.trim();
    if image.is_empty() || image.contains('@') {
        return None;
    }
    let (_, tag) = image.rsplit_once(':')?;
    (!tag.is_empty() && !tag.contains('/')).then_some(tag)
}

/// The static release asset target for the running architecture.
pub fn release_target() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "x86_64" => Ok("x86_64-unknown-linux-musl"),
        "aarch64" => Ok("aarch64-unknown-linux-musl"),
        arch => Err(format!(
            "churn self-update is not available for architecture {arch}; \
             install the new release with install.sh"
        )),
    }
}

pub fn asset_name(target: &str) -> String {
    format!("churn-{target}")
}

pub fn release_asset_url(version: &str, asset: &str) -> String {
    format!("{RELEASE_DOWNLOAD_BASE}/v{version}/{asset}")
}

/// Fetch the latest release metadata from GitHub.
pub fn fetch_latest_release() -> io::Result<Release> {
    let body = fetch_text(LATEST_RELEASE_URL, REQUEST_TIMEOUT)?;
    parse_latest_release(&body)
}

/// Download a release asset, with a hard size cap.
pub fn download(url: &str) -> io::Result<Vec<u8>> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(DOWNLOAD_TIMEOUT)
        .call()
        .map_err(|err| http_error(url, err))?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_DOWNLOAD_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_DOWNLOAD_BYTES {
        return Err(io::Error::other(format!(
            "{url} is larger than the {} MiB download limit",
            MAX_DOWNLOAD_BYTES / (1024 * 1024)
        )));
    }
    Ok(bytes)
}

/// Fetch a small text response (the `.sha256` sidecar).
pub fn fetch_text(url: &str, timeout: Duration) -> io::Result<String> {
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .timeout(timeout)
        .call()
        .map_err(|err| http_error(url, err))?;
    response.into_string().map_err(io::Error::other)
}

fn http_error(url: &str, err: ureq::Error) -> io::Error {
    io::Error::other(format!("request to {url} failed: {err}"))
}

/// Extract the SHA-256 digest from a `sha256sum`-style checksum file.
pub fn parse_checksum(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|token| token.len() == 64 && token.chars().all(|ch| ch.is_ascii_hexdigit()))
        .map(|token| token.to_ascii_lowercase())
}

pub fn verify_sha256(bytes: &[u8], expected: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize()).eq_ignore_ascii_case(expected)
}

/// True for binaries built and run from a Cargo checkout rather than installed.
pub fn is_checkout_binary(path: &Path) -> bool {
    path.ancestors().any(|dir| {
        matches!(
            dir.file_name().and_then(|name| name.to_str()),
            Some("debug" | "release")
        ) && dir
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|name| name == "target")
    })
}

fn sibling_path(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    exe.with_file_name(name)
}

pub fn binary_backup_path(exe: &Path) -> PathBuf {
    sibling_path(exe, ".previous")
}

fn binary_temp_path(exe: &Path) -> PathBuf {
    sibling_path(exe, &format!(".new.{}", std::process::id()))
}

/// Atomically replace `exe` with `bytes`, keeping the old file as `.previous`.
pub fn replace_binary(exe: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = exe
        .parent()
        .ok_or_else(|| io::Error::other(format!("{} has no parent directory", exe.display())))?;
    fs::create_dir_all(parent)?;

    let temporary = binary_temp_path(exe);
    let backup = binary_backup_path(exe);

    let result = (|| {
        fs::write(&temporary, bytes)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o755))?;
        fs::File::open(&temporary)?.sync_all()?;

        if exe.exists() {
            if backup.exists() {
                fs::remove_file(&backup)?;
            }
            fs::rename(exe, &backup)?;
        }
        if let Err(err) = fs::rename(&temporary, exe) {
            if backup.exists() {
                let _ = fs::rename(&backup, exe);
            }
            return Err(err);
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn restore_binary(exe: &Path) -> io::Result<()> {
    let backup = binary_backup_path(exe);
    if backup.exists() {
        fs::rename(&backup, exe)?;
    }
    Ok(())
}

pub fn remove_binary_backup(exe: &Path) -> io::Result<()> {
    match fs::remove_file(binary_backup_path(exe)) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_latest_release_and_normalizes_the_tag() {
        let release = parse_latest_release(
            r#"{"tag_name":"v0.1.4","html_url":"https://example.test/v0.1.4"}"#,
        )
        .unwrap();
        assert_eq!(release.version, "0.1.4");
        assert_eq!(release.url, "https://example.test/v0.1.4");
        assert!(parse_latest_release(r#"{"html_url":"https://example.test"}"#).is_err());
    }

    #[test]
    fn versions_are_strict_three_part_numbers() {
        assert_eq!(normalize_version("v0.1.4").unwrap(), "0.1.4");
        assert_eq!(normalize_version(" 0.1.4 ").unwrap(), "0.1.4");
        for invalid in ["latest", "0.1", "0.1.4.5", "v0.1.4-rc1", "01.2.3", ""] {
            assert!(
                normalize_version(invalid).is_err(),
                "{invalid:?} should be rejected"
            );
        }
    }

    #[test]
    fn image_tags_ignore_registry_ports_and_reject_digests() {
        assert_eq!(
            image_tag("ghcr.io/git-monke/churn-dashboard:0.1.4"),
            Some("0.1.4")
        );
        assert_eq!(image_tag("localhost:5000/churn:dev"), Some("dev"));
        assert_eq!(image_tag("localhost:5000/churn"), None);
        assert_eq!(image_tag("ghcr.io/churn@sha256:abc"), None);
        assert_eq!(image_tag("churn"), None);
    }

    #[test]
    fn asset_names_match_install_sh() {
        match std::env::consts::ARCH {
            "x86_64" => assert_eq!(release_target().unwrap(), "x86_64-unknown-linux-musl"),
            "aarch64" => assert_eq!(release_target().unwrap(), "aarch64-unknown-linux-musl"),
            _ => assert!(release_target().is_err()),
        }
        assert_eq!(
            asset_name("x86_64-unknown-linux-musl"),
            "churn-x86_64-unknown-linux-musl"
        );
        assert_eq!(
            release_asset_url("0.1.4", "churn-x86_64-unknown-linux-musl"),
            "https://github.com/git-monke/churn/releases/download/v0.1.4/churn-x86_64-unknown-linux-musl"
        );
    }

    #[test]
    fn checksum_files_are_parsed_and_verified() {
        let text = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824  churn-x86_64-unknown-linux-musl\n";
        let digest = parse_checksum(text).unwrap();
        assert_eq!(
            digest,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
        assert!(verify_sha256(b"hello", &digest));
        assert!(!verify_sha256(b"hello!", &digest));
        assert_eq!(parse_checksum("not a checksum"), None);
    }

    #[test]
    fn checkout_binaries_are_detected() {
        assert!(is_checkout_binary(Path::new(
            "/home/me/churn/target/debug/churn"
        )));
        assert!(is_checkout_binary(Path::new(
            "/home/me/churn/target/release/churn"
        )));
        assert!(!is_checkout_binary(Path::new("/usr/local/bin/churn")));
        assert!(!is_checkout_binary(Path::new(
            "/home/me/churn/target/debug-tools/churn"
        )));
    }

    #[test]
    fn replacing_a_binary_keeps_the_old_one_as_a_backup() {
        let dir = std::env::temp_dir().join(format!(
            "churn-update-replace-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("churn");
        fs::write(&exe, b"old").unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();

        replace_binary(&exe, b"new").unwrap();

        assert_eq!(fs::read(&exe).unwrap(), b"new");
        assert_eq!(fs::read(binary_backup_path(&exe)).unwrap(), b"old");
        assert_eq!(
            fs::metadata(&exe).unwrap().permissions().mode() & 0o777,
            0o755
        );

        remove_binary_backup(&exe).unwrap();
        assert!(!binary_backup_path(&exe).exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
