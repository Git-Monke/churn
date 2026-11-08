//! Preflight, copy, verify and `.env` rewrite for `churn migrate`.
//!
//! Only the host download directory moves. Every container keeps mounting it at
//! `/data`, so qBittorrent, Sonarr, Radarr and Jellyfin continue to use the
//! same container paths and need no per-service reconfiguration. Relocating a
//! `MEDIA_DIR` that lives elsewhere is follow-up `churn-scz2`. The old data
//! is retained by default and only removed after a verified copy, a healthy
//! restart and an explicit `--move`.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::envfile;
use crate::question;
use crate::stack::{self, Stack};
use crate::system;

/// Marker written into the destination while a copy is in progress. Its
/// presence makes a later run resume instead of refusing a non-empty target.
pub const MARKER: &str = ".churn-migrate.json";
/// Backup of the pre-migration `.env`, kept for a one-command rollback.
pub const ENV_BACKUP: &str = ".env.churn-migrate.bak";

const NFS_SUPER_MAGIC: i64 = 0x6969;
const SMB_SUPER_MAGIC: i64 = 0x517b;
const SMB2_SUPER_MAGIC: i64 = 0xfe534d42;
const CIFS_MAGIC_NUMBER: i64 = 0xff534d42;
const FUSE_SUPER_MAGIC: i64 = 0x65735546;
const AFS_SUPER_MAGIC: i64 = 0x5346414f;
const NINE_P_SUPER_MAGIC: i64 = 0x01021997;
const NETWORK_FILESYSTEMS: [i64; 7] = [
    NFS_SUPER_MAGIC,
    SMB_SUPER_MAGIC,
    SMB2_SUPER_MAGIC,
    CIFS_MAGIC_NUMBER,
    FUSE_SUPER_MAGIC,
    AFS_SUPER_MAGIC,
    NINE_P_SUPER_MAGIC,
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TreeStats {
    pub bytes: u64,
    pub files: u64,
    pub directories: u64,
    pub links: u64,
}

/// One `rsync --info=progress2` update.
///
/// rsync reports its own percentage, which is relative to the bytes it still
/// has to transfer rather than to the whole tree, so a resumed copy can sit at
/// `100%` after a few megabytes. Callers should therefore drive a bar from
/// `percent` and treat the absolute figures as informational.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Progress2 {
    /// Bytes transferred so far.
    pub bytes: u64,
    /// rsync's own completion percentage, 0..=100.
    pub percent: u8,
    /// Transfer rate exactly as rsync printed it, e.g. `3.00GB/s`.
    pub rate: String,
    /// Remaining time exactly as rsync printed it, e.g. `0:00:12`.
    pub eta: String,
    /// Files transferred (`xfr#N`).
    pub files_done: u64,
    /// Files still to check (`to-chk=L`).
    pub files_left: u64,
    /// Files in the transfer (`to-chk=L/T`).
    pub files_total: u64,
}

/// One event from a `rsync` run, or a line it printed that was not progress.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CopyEvent<'a> {
    Progress(Progress2),
    Line(&'a str),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VerifyReport {
    pub files: u64,
    pub bytes: u64,
    pub directories: u64,
    pub links: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    /// Which of the two storage directories this plan moves.
    pub target: StorageTarget,
    pub source: PathBuf,
    pub destination: PathBuf,
    pub total_bytes: u64,
    /// Bytes still to copy. Less than `total_bytes` when resuming.
    pub remaining_bytes: u64,
    pub available_bytes: u64,
    pub resuming: bool,
    pub network_filesystem: bool,
    /// The media library and the download directory end up on different
    /// filesystems, so arr imports become copy-then-delete instead of hardlinks.
    pub splits_imports: bool,
    pub stacks: Vec<Stack>,
}

/// The storage directory a migration moves.
///
/// The library is the interesting one — it is the large, rarely-changing tree
/// users outgrow, and moving it does not disturb in-flight torrents. The
/// download directory stays opt-in for that reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum StorageTarget {
    /// `MEDIA_DIR`, where the finished library lives. The default.
    #[default]
    Media,
    /// `DOWNLOAD_DIR`, where in-progress downloads live.
    Download,
}

impl StorageTarget {
    pub fn env_key(self) -> &'static str {
        match self {
            StorageTarget::Media => "MEDIA_DIR",
            StorageTarget::Download => "DOWNLOAD_DIR",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            StorageTarget::Media => "media directory",
            StorageTarget::Download => "download directory",
        }
    }

    /// Whether moving this target also moves the other one.
    ///
    /// In the default layout `MEDIA_DIR` is `<DOWNLOAD_DIR>/media`, so a media
    /// move leaves the download directory in place and only changes where the
    /// library is mounted. A download move drags a nested library with it,
    /// because deleting the old download directory would otherwise take the
    /// media tree with it.
    pub fn carries_nested_other(self) -> bool {
        matches!(self, StorageTarget::Download)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvBackup {
    pub path: PathBuf,
    pub backup: PathBuf,
    original: String,
}

#[derive(Clone, Copy, Debug)]
struct FilesystemStats {
    available_bytes: u64,
    read_only: bool,
    fs_type: i64,
}

impl FilesystemStats {
    fn is_network(self) -> bool {
        NETWORK_FILESYSTEMS.contains(&self.fs_type)
    }
}

#[derive(Serialize, Deserialize)]
struct Marker {
    version: u32,
    source: String,
    destination: String,
    started_unix: u64,
}

/// Stacks with generated state under `root`.
pub fn installed_stacks(root: &Path) -> Vec<Stack> {
    Stack::ALL
        .into_iter()
        .filter(|stack| {
            env_path(root, *stack).is_file()
                && root.join(stack.key()).join("docker-compose.yml").is_file()
        })
        .collect()
}

fn env_path(root: &Path, stack: Stack) -> PathBuf {
    root.join(stack.key()).join(".env")
}

/// Read the current storage path from every installed stack.
///
/// A mismatch means a previous partial edit; refuse rather than pick one.
/// Accepts a legacy `DATA_DIR` key so a pre-split install can still relocate,
/// and derives the media directory when the file predates the split.
pub fn current_storage(
    root: &Path,
    stacks: &[Stack],
    target: StorageTarget,
) -> io::Result<PathBuf> {
    let mut found: Option<(Stack, PathBuf)> = None;
    for stack in stacks {
        let env = envfile::read(&env_path(root, *stack));
        let Some(value) = storage_value(&env, target) else {
            continue;
        };
        let path = PathBuf::from(question::normalize_path(&value));
        if let Some((other, existing)) = &found {
            if existing != &path {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "the stacks disagree about the {}: {} has {}, {} has {}.\n\
                         Fix both .env files before migrating.",
                        target.label(),
                        other.key(),
                        existing.display(),
                        stack.key(),
                        path.display()
                    ),
                ));
            }
        } else {
            found = Some((*stack, path));
        }
    }
    match found {
        Some((_, path)) => Ok(path),
        None => Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "no {} found in {}; run the installer first",
                target.env_key(),
                stacks
                    .iter()
                    .map(|stack| env_path(root, *stack).display().to_string())
                    .collect::<Vec<_>>()
                    .join(" and ")
            ),
        )),
    }
}

/// One `.env` file's value for `target`, or the implied default.
///
/// A pre-split file has only the download path; the media directory was then
/// always `<DOWNLOAD_DIR>/media`, which is exactly what the installer writes
/// for a default answer.
fn storage_value(env: &envfile::EnvMap, target: StorageTarget) -> Option<String> {
    match target {
        StorageTarget::Download => envfile::storage_path(env, "DOWNLOAD_DIR"),
        StorageTarget::Media => envfile::storage_path(env, "MEDIA_DIR").or_else(|| {
            envfile::storage_path(env, "DOWNLOAD_DIR").map(|download| {
                format!(
                    "{}/{}",
                    question::normalize_path(&download),
                    stack::MEDIA_SUBDIR
                )
            })
        }),
    }
}

/// Validate the target and collect everything the confirmation screen shows.
pub fn plan(
    root: &Path,
    stacks: &[Stack],
    target: StorageTarget,
    destination: &Path,
    allow_network_filesystem: bool,
) -> io::Result<Plan> {
    let source = current_storage(root, stacks, target)?;
    let source = fs::canonicalize(&source).map_err(|err| {
        io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "cannot read the current {} {}: {err}",
                target.label(),
                source.display()
            ),
        )
    })?;

    if destination.as_os_str().is_empty() || !destination.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the destination must be an absolute path",
        ));
    }
    if destination
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "the destination must not contain '..' components",
        ));
    }
    if let Err(message) = validate_target(destination) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, message));
    }

    let destination = canonical_target(destination)?;
    if source == destination {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} is already the {}", source.display(), target.label()),
        ));
    }
    if destination.starts_with(&source) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is inside the current {} {}",
                destination.display(),
                target.label(),
                source.display()
            ),
        ));
    }
    if source.starts_with(&destination) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the current {} {} is inside {}",
                target.label(),
                source.display(),
                destination.display()
            ),
        ));
    }

    let (resuming, copied_bytes) = inspect_destination(&source, &destination)?;
    let filesystem = filesystem_stats(&nearest_existing(&destination))?;
    if filesystem.read_only {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is on a read-only filesystem", destination.display()),
        ));
    }
    if filesystem.is_network() && !allow_network_filesystem {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} is on a network filesystem; SQLite and interactive media use are unsafe there.\n\
                 Pass --allow-network-fs to acknowledge the risk.",
                destination.display()
            ),
        ));
    }

    let total = scan_tree(&source)?;
    let remaining = if resuming {
        total.bytes.saturating_sub(copied_bytes)
    } else {
        total.bytes
    };
    if remaining > filesystem.available_bytes {
        return Err(io::Error::new(
            io::ErrorKind::StorageFull,
            format!(
                "{} needs {} but only {} is free on {}",
                if resuming {
                    "the remaining copy"
                } else {
                    "the copy"
                },
                format_bytes(remaining),
                format_bytes(filesystem.available_bytes),
                destination.display()
            ),
        ));
    }

    let splits_imports = splits_imports(root, stacks, target, &destination)?;
    Ok(Plan {
        target,
        source,
        destination,
        total_bytes: total.bytes,
        remaining_bytes: remaining,
        available_bytes: filesystem.available_bytes,
        resuming,
        network_filesystem: filesystem.is_network(),
        splits_imports,
        stacks: stacks.to_vec(),
    })
}

/// Whether the move leaves the library and the downloads on different
/// filesystems.
///
/// Sonarr and Radarr import a finished download by hardlinking (or atomically
/// renaming) it into the library, which only works within one filesystem.
/// Across two, every import becomes a full copy followed by a delete.
///
/// A media move is judged by the new library path against the download
/// directory that stays put. A download move takes the media directory with it
/// (see `StorageTarget::carries_nested_other`), so the pair stays together and
/// the answer is always `false`.
fn splits_imports(
    root: &Path,
    stacks: &[Stack],
    target: StorageTarget,
    destination: &Path,
) -> io::Result<bool> {
    if target == StorageTarget::Download {
        return Ok(false);
    }
    let Ok(download) = current_storage(root, stacks, StorageTarget::Download) else {
        return Ok(false);
    };
    let download = canonical_target(&download)?;
    let library_device = device_of(&nearest_existing(destination));
    let download_device = device_of(&nearest_existing(&download));
    Ok(match (library_device, download_device) {
        (Some(library), Some(download)) => library != download,
        _ => false,
    })
}

fn device_of(path: &Path) -> Option<u64> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).ok().map(|metadata| metadata.dev())
}

/// Reuse the installer's absolute-path, existence and writability checks.
fn validate_target(path: &Path) -> Result<(), String> {
    question::validate_data_dir(&path.to_string_lossy())
}

/// The destination as an absolute path with symlinks in its existing ancestors
/// resolved. Missing trailing components are appended unchanged.
pub fn canonical_target(path: &Path) -> io::Result<PathBuf> {
    let mut current = path.to_path_buf();
    let mut missing = Vec::new();
    loop {
        match fs::canonicalize(&current) {
            Ok(mut base) => {
                for part in missing.iter().rev() {
                    base.push(part);
                }
                return Ok(base);
            }
            Err(_) => {
                let name = current.file_name().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("cannot resolve {}", path.display()),
                    )
                })?;
                missing.push(name.to_os_string());
                current = current
                    .parent()
                    .ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!("cannot resolve {}", path.display()),
                        )
                    })?
                    .to_path_buf();
            }
        }
    }
}

fn nearest_existing(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    while !current.exists() {
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => break,
        }
    }
    current
}

/// Whether an existing destination is empty/resumable, plus its current size.
fn inspect_destination(source: &Path, destination: &Path) -> io::Result<(bool, u64)> {
    if !destination.exists() {
        return Ok((false, 0));
    }
    if !destination.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} exists but is not a directory", destination.display()),
        ));
    }
    let mut entries = fs::read_dir(destination)?;
    if entries.next().is_none() {
        return Ok((false, 0));
    }

    let marker_path = destination.join(MARKER);
    if marker_path.is_file() {
        let marker = read_marker(&marker_path)?;
        if marker.source == source.to_string_lossy() {
            let mut stats = scan_tree(destination)?;
            if let Ok(metadata) = fs::metadata(&marker_path) {
                stats.bytes = stats.bytes.saturating_sub(metadata.len());
            }
            return Ok((true, stats.bytes));
        }
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "{} contains a partial copy of {}; refusing to merge copies from different sources",
                destination.display(),
                marker.source
            ),
        ));
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!(
            "{} is not empty; choose an empty directory or remove its contents first",
            destination.display()
        ),
    ))
}

pub fn write_marker(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    let marker = Marker {
        version: 1,
        source: source.to_string_lossy().to_string(),
        destination: destination.to_string_lossy().to_string(),
        started_unix: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or_default(),
    };
    let body = serde_json::to_string_pretty(&marker)
        .map_err(|err| io::Error::other(format!("could not encode migration marker: {err}")))?;
    envfile::write_atomic(&destination.join(MARKER), &body)
}

pub fn clear_marker(destination: &Path) {
    let _ = fs::remove_file(destination.join(MARKER));
}

fn read_marker(path: &Path) -> io::Result<Marker> {
    let body = fs::read_to_string(path)?;
    serde_json::from_str(&body).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} is not a valid churn migration marker: {err}",
                path.display()
            ),
        )
    })
}

/// Walk a tree without following symlinks.
pub fn scan_tree(path: &Path) -> io::Result<TreeStats> {
    let mut stats = TreeStats::default();
    scan_into(path, &mut stats)?;
    Ok(stats)
}

fn scan_into(path: &Path, stats: &mut TreeStats) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(path)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path())?;
        let file_type = metadata.file_type();
        if file_type.is_dir() {
            stats.directories += 1;
            scan_into(&entry.path(), stats)?;
        } else if file_type.is_file() {
            stats.files += 1;
            stats.bytes = stats.bytes.saturating_add(metadata.len());
        } else if file_type.is_symlink() {
            stats.links += 1;
        }
    }
    Ok(())
}

/// Verify that every source entry exists at the destination with the same size
/// (and symlinks with the same target). This is the gate before `.env` changes.
pub fn verify_tree(source: &Path, destination: &Path) -> io::Result<VerifyReport> {
    if !destination.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{} is missing after the copy", destination.display()),
        ));
    }
    let mut report = VerifyReport::default();
    verify_into(source, destination, &mut report)?;
    Ok(report)
}

fn verify_into(source: &Path, destination: &Path, report: &mut VerifyReport) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(source)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let source_path = entry.path();
        let relative = source_path
            .strip_prefix(source)
            .unwrap_or(source_path.as_path());
        let destination_path = destination.join(relative);
        let source_meta = fs::symlink_metadata(&source_path)?;
        let destination_meta = fs::symlink_metadata(&destination_path).map_err(|err| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "{} is missing after the copy: {err}",
                    destination_path.display()
                ),
            )
        })?;

        if source_meta.file_type().is_dir() {
            if !destination_meta.is_dir() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} is not a directory after the copy",
                        destination_path.display()
                    ),
                ));
            }
            report.directories += 1;
            verify_into(&source_path, &destination_path, report)?;
        } else if source_meta.file_type().is_file() {
            if !destination_meta.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} is not a file after the copy",
                        destination_path.display()
                    ),
                ));
            }
            if source_meta.len() != destination_meta.len() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} has {} bytes, expected {}",
                        destination_path.display(),
                        destination_meta.len(),
                        source_meta.len()
                    ),
                ));
            }
            report.files += 1;
            report.bytes = report.bytes.saturating_add(source_meta.len());
        } else if source_meta.file_type().is_symlink() {
            if fs::read_link(&source_path)? != fs::read_link(&destination_path)? {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} points at a different target after the copy",
                        destination_path.display()
                    ),
                ));
            }
            report.links += 1;
        }
    }
    Ok(())
}

/// Copy the contents of `source` into `destination`.
///
/// rsync is preferred because `--partial` makes an interrupted run resumable.
/// A plain `cp -a` fallback preserves ownership and permissions but restarts
/// the affected file, and never reports progress.
pub fn copy(
    source: &Path,
    destination: &Path,
    on_event: &mut dyn FnMut(CopyEvent<'_>),
) -> io::Result<()> {
    fs::create_dir_all(destination)?;

    let command = if system::which("rsync") {
        let mut command = Command::new("rsync");
        command
            .args([
                "-aH",
                "--numeric-ids",
                "--partial",
                "--info=progress2",
                "--delete",
                "--exclude",
                MARKER,
            ])
            .arg(with_trailing_slash(source))
            .arg(with_trailing_slash(destination));
        command
    } else {
        let mut command = Command::new("cp");
        command.arg("-a").arg(source.join(".")).arg(destination);
        command
    };

    let mut emit = |line: &str| match parse_progress2(line) {
        Some(progress) => on_event(CopyEvent::Progress(progress)),
        None => on_event(CopyEvent::Line(line)),
    };
    let output = system::run_streaming(command, &mut emit)?;
    if output.status.success() {
        return Ok(());
    }

    // Progress frames would fill the whole tail and push the actual complaint
    // out of the 200 retained lines.
    let detail = output
        .tail
        .iter()
        .filter(|line| parse_progress2(line).is_none())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    let mut message = format!(
        "copy from {} to {} failed ({})",
        source.display(),
        destination.display(),
        output.status
    );
    if !detail.is_empty() {
        message.push('\n');
        message.push_str(&detail);
    }
    if let Some(explanation) = copy_failure_explanation(output.status.code(), &output.tail) {
        message.push_str("\n\n");
        message.push_str(&explanation);
    }
    Err(io::Error::other(message))
}

/// Parse one `--info=progress2` update, or `None` for any other output.
///
/// rsync prints these as `\r`-terminated frames that look like
///
/// ```text
///      1,234,567  45%    3.00GB/s    0:00:12 (xfr#12, to-chk=48/60)
/// ```
///
/// The shape is matched strictly: anything unrecognised (file names, `deleting
/// …`, `rsync error: …`, rsync's closing `sent … bytes` summary) is reported as
/// a plain [`CopyEvent::Line`] instead of being mistaken for progress.
pub fn parse_progress2(line: &str) -> Option<Progress2> {
    let mut fields = line.split_whitespace();
    let bytes = parse_grouped_u64(fields.next()?)?;
    let percent = fields.next()?.strip_suffix('%')?.parse::<u8>().ok()?;
    if percent > 100 {
        return None;
    }
    let rate = fields.next()?;
    if !rate.ends_with("B/s") {
        return None;
    }
    let eta = fields.next()?;
    if !is_eta(eta) {
        return None;
    }

    let mut progress = Progress2 {
        bytes,
        percent,
        rate: rate.to_string(),
        eta: eta.to_string(),
        ..Progress2::default()
    };
    for field in fields {
        if let Some(value) = field.strip_prefix("(xfr#") {
            progress.files_done = value.trim_end_matches(',').parse().ok()?;
        } else if let Some(value) = field.strip_prefix("to-chk=") {
            let (left, total) = value.trim_end_matches(')').split_once('/')?;
            progress.files_left = left.parse().ok()?;
            progress.files_total = total.parse().ok()?;
        }
    }
    Some(progress)
}

/// A digit run with rsync's thousands separators, e.g. `41,943,040`.
fn parse_grouped_u64(field: &str) -> Option<u64> {
    let digits: String = field.chars().filter(|ch| *ch != ',').collect();
    if digits.is_empty() || !digits.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// `H:MM:SS` or `MM:SS`, both of which rsync prints.
fn is_eta(field: &str) -> bool {
    let mut parts = field.split(':');
    let (Some(first), second, third) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    if parts.next().is_some() || second.is_none() || third.is_none() {
        return false;
    }
    [Some(first), second, third]
        .into_iter()
        .flatten()
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

/// Explain the common "files look complete but rsync still failed" case.
///
/// With `--partial`, rsync can leave a destination file at its final path even
/// after its post-transfer verification fails. The size can therefore match the
/// source while the contents are not trustworthy, so do not let a size-only
/// resume estimate imply the copy is valid.
fn copy_failure_explanation(code: Option<i32>, tail: &[String]) -> Option<String> {
    let detail = tail.join("\n").to_ascii_lowercase();
    let read_errors = detail.contains("read errors")
        || detail.contains("input/output error")
        || detail.contains("failed verification");
    if !read_errors && code != Some(23) {
        return None;
    }

    if read_errors {
        return Some(
            "rsync could not read every source file, or its post-transfer verification failed.\n\
             This usually means the source disk, filesystem or mount returned bad data\n\
             (corruption, bad sectors, a failing cable or a dropped network/removable volume).\n\n\
             Such a file can exist in the destination with the same size as the source and\n\
             still be incomplete or corrupt; matching sizes do not prove a valid copy.\n\n\
             The old .env is unchanged, so the stacks are still using the original data.\n\
             The destination and its marker were kept for resuming, but fix or restore the\n\
             unreadable source files before re-running the same command."
                .to_string(),
        );
    }

    Some(
        "rsync exited with code 23: some files or attributes were not transferred.\n\
         See the rsync log above for the affected paths. This is not necessarily\n\
         corruption (permissions and vanished files also produce code 23), but it is\n\
         not a clean copy either.\n\n\
         The old .env is unchanged, so the stacks are still using the original data.\n\
         The destination and its marker were kept for resuming; fix the reported\n\
         problem before re-running the same command."
            .to_string(),
    )
}

fn with_trailing_slash(path: &Path) -> PathBuf {
    let mut path = path.to_path_buf();
    path.push("");
    path
}

/// Existing `PUID`/`PGID` win so copied files keep the ownership the services
/// already use. A fresh destination falls back to its own owner.
pub fn storage_owner(root: &Path, stacks: &[Stack], destination: &Path) -> (u32, u32) {
    let mut uid = None;
    let mut gid = None;
    for stack in stacks {
        let env = envfile::read(&env_path(root, *stack));
        if uid.is_none() {
            uid = env.get("PUID").and_then(|value| value.trim().parse().ok());
        }
        if gid.is_none() {
            gid = env.get("PGID").and_then(|value| value.trim().parse().ok());
        }
    }
    match (uid, gid) {
        (Some(uid), Some(gid)) => (uid, gid),
        _ => envfile::owner(destination),
    }
}

/// Give the destination root the owner the containers expect, so they can
/// create new media folders there.
pub fn set_owner(path: &Path, uid: u32, gid: u32) -> io::Result<()> {
    let path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;
    if unsafe { libc::chown(path.as_ptr(), uid, gid) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Write the moved storage key and `PUID`/`PGID` into every stack's `.env`.
///
/// A backup is written first, and a failure part-way through restores the
/// files already changed so the installation never points at a half-written
/// configuration. A legacy `DATA_DIR` is dropped so the file never carries both
/// keys.
///
/// A download move also rewrites `MEDIA_DIR` when it lives inside the directory
/// being moved (the default `<DOWNLOAD_DIR>/media` layout). Leaving it alone
/// would be a data-loss bug with `--move`: the media tree is copied to the
/// destination and then deleted with the old download directory, while `.env`
/// still pointed at the deleted path.
pub fn write_envs(
    root: &Path,
    stacks: &[Stack],
    target: StorageTarget,
    destination: &Path,
    uid: u32,
    gid: u32,
) -> io::Result<Vec<EnvBackup>> {
    let destination = destination.to_string_lossy().to_string();
    let uid = uid.to_string();
    let gid = gid.to_string();

    let mut backups: Vec<EnvBackup> = Vec::new();
    for stack in stacks {
        let path = env_path(root, *stack);
        if !path.is_file() {
            continue;
        }
        let original = fs::read_to_string(&path)?;
        let mut values: Vec<(&str, String)> = vec![
            (target.env_key(), destination.clone()),
            ("PUID", uid.clone()),
            ("PGID", gid.clone()),
        ];
        if target.carries_nested_other()
            && let Some(media) = relocated_media(&original, &destination)
        {
            values.push(("MEDIA_DIR", media));
        }
        let borrowed: Vec<(&str, &str)> = values
            .iter()
            .map(|(key, value)| (*key, value.as_str()))
            .collect();

        let backup = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(ENV_BACKUP);
        if let Err(err) = envfile::write_atomic(&backup, &original) {
            let _ = restore_envs(&backups);
            return Err(err);
        }
        if let Ok(metadata) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(&backup, metadata.permissions());
        }
        backups.push(EnvBackup {
            path: path.clone(),
            backup,
            original: original.clone(),
        });
        if let Err(err) = envfile::upsert_many(&path, &borrowed)
            .and_then(|()| envfile::remove_keys(&path, &["DATA_DIR"]))
        {
            let _ = restore_envs(&backups);
            return Err(err);
        }
    }
    Ok(backups)
}

/// Where the media directory must point after the download directory moved.
///
/// `None` means the file's storage keys could not be read, so `MEDIA_DIR` is
/// left exactly as it was. A media path inside the old download directory is
/// rebased onto the destination; anything else is returned unchanged, because
/// a download move only moves the download tree.
fn relocated_media(original: &str, destination: &str) -> Option<String> {
    let env = envfile::parse(original);
    let old_download = envfile::storage_path(&env, "DOWNLOAD_DIR")?;
    let old_download = question::normalize_path(&old_download);
    let media = envfile::storage_path(&env, "MEDIA_DIR")
        .map(|value| question::normalize_path(&value))
        .unwrap_or_else(|| format!("{old_download}/{}", stack::MEDIA_SUBDIR));

    let inside = media == old_download || Path::new(&media).starts_with(Path::new(&old_download));
    if !inside {
        return Some(media);
    }
    let relative = Path::new(&media)
        .strip_prefix(Path::new(&old_download))
        .unwrap_or_else(|_| Path::new(""));
    Some(format!("{}/{}", destination, relative.display()))
}

/// Restore every `.env` from its pre-migration backup.
pub fn restore_envs(backups: &[EnvBackup]) -> io::Result<()> {
    for entry in backups {
        envfile::write_atomic(&entry.path, &entry.original)?;
    }
    Ok(())
}

/// Remove the contents of the old download directory, keeping the directory itself
/// so the old mount point still exists.
pub fn remove_old_data(source: &Path) -> io::Result<()> {
    for entry in fs::read_dir(source)? {
        let path = entry?.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            fs::remove_dir_all(&path)?;
        } else {
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

impl Plan {
    /// Multi-line rollback instructions for the environment files.
    pub fn rollback_hint(&self, root: &Path) -> String {
        let mut lines = String::new();
        for stack in &self.stacks {
            lines.push_str(&format!(
                "  cp '{}' '{}'\n",
                env_path(root, *stack).with_file_name(ENV_BACKUP).display(),
                env_path(root, *stack).display()
            ));
        }
        lines.push_str("then restart the stacks with `docker compose up -d`.");
        lines
    }
}

pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

fn filesystem_stats(path: &Path) -> io::Result<FilesystemStats> {
    let c_path = CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))?;

    let mut vfs: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut vfs) } != 0 {
        return Err(io::Error::last_os_error());
    }

    let mut sfs: libc::statfs = unsafe { std::mem::zeroed() };
    let fs_type = if unsafe { libc::statfs(c_path.as_ptr(), &mut sfs) } == 0 {
        sfs.f_type as i64
    } else {
        0
    };

    let block_size = vfs.f_frsize.max(vfs.f_bsize).max(1) as u64;
    Ok(FilesystemStats {
        available_bytes: vfs.f_bavail as u64 * block_size,
        read_only: vfs.f_flag & libc::ST_RDONLY != 0,
        fs_type,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let id = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("churn-migrate-{}-{label}-{id}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_dir(label);
        let source = root.join("old");
        let destination = root.join("new");
        fs::create_dir_all(source.join("media/movies")).unwrap();
        fs::write(source.join("media/movies/film.mkv"), b"123456").unwrap();
        fs::create_dir_all(source.join("incomplete")).unwrap();
        for stack in Stack::ALL {
            let dir = root.join(stack.key());
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("docker-compose.yml"), "").unwrap();
            fs::write(
                dir.join(".env"),
                format!(
                    "DOWNLOAD_DIR={}\nPUID=1000\nPGID=1000\nKEEP=yes\n",
                    source.display()
                ),
            )
            .unwrap();
        }
        (root, source, destination)
    }

    #[test]
    fn current_storage_is_shared_and_rejects_a_mismatch() {
        let (root, source, _) = fixture("current");
        let stacks = installed_stacks(&root);
        assert_eq!(stacks, vec![Stack::Server, Stack::Torrent]);
        assert_eq!(
            current_storage(&root, &stacks, StorageTarget::Download).unwrap(),
            source
        );

        fs::write(
            root.join("torrent/.env"),
            format!("DOWNLOAD_DIR={}\n", root.join("other").display()),
        )
        .unwrap();
        assert!(current_storage(&root, &stacks, StorageTarget::Download).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_pre_split_env_derives_the_media_directory() {
        let (root, source, _) = fixture("derive");
        let stacks = installed_stacks(&root);
        // The fixture writes only DOWNLOAD_DIR, like an install from before the
        // split; the installer's default media directory is <DOWNLOAD_DIR>/media.
        assert_eq!(
            current_storage(&root, &stacks, StorageTarget::Media).unwrap(),
            source.join("media")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plan_rejects_nested_and_non_empty_destinations() {
        let (root, source, destination) = fixture("nesting");
        let stacks = installed_stacks(&root);

        let download = StorageTarget::Download;
        assert!(plan(&root, &stacks, download, &source.join("nested"), false).is_err());
        assert!(
            plan(
                &root,
                &stacks,
                download,
                &source.parent().unwrap().join("old"),
                false
            )
            .is_err()
        );
        assert!(plan(&root, &stacks, download, &source, false).is_err());

        fs::create_dir_all(&destination).unwrap();
        fs::write(destination.join("keep.txt"), b"keep").unwrap();
        assert!(plan(&root, &stacks, download, &destination, false).is_err());
        fs::remove_dir_all(&destination).unwrap();

        let plan = plan(&root, &stacks, download, &destination, false).unwrap();
        assert_eq!(plan.total_bytes, 6);
        assert!(!plan.resuming);
        assert_eq!(plan.stacks, stacks);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_marker_allows_resuming_the_same_source() {
        let (root, source, destination) = fixture("resume");
        let stacks = installed_stacks(&root);
        fs::create_dir_all(&destination).unwrap();
        write_marker(&source, &destination).unwrap();
        fs::write(destination.join("partial.bin"), b"12").unwrap();

        let plan = plan(&root, &stacks, StorageTarget::Download, &destination, false).unwrap();
        assert!(plan.resuming);
        assert_eq!(plan.remaining_bytes, 4);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writing_a_marker_creates_a_missing_destination() {
        let (root, source, destination) = fixture("marker-create");
        assert!(!destination.exists());
        write_marker(&source, &destination).unwrap();
        assert!(destination.join(MARKER).is_file());
        assert!(
            plan(
                &root,
                &installed_stacks(&root),
                StorageTarget::Download,
                &destination,
                false
            )
            .unwrap()
            .resuming
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_verify_and_remove_old_data_preserve_a_complete_tree() {
        let (root, source, destination) = fixture("copy");
        symlink("media/movies/film.mkv", source.join("link")).unwrap();

        copy(&source, &destination, &mut |_| {}).unwrap();
        let report = verify_tree(&source, &destination).unwrap();
        assert_eq!(report.files, 1);
        assert_eq!(report.bytes, 6);
        assert_eq!(report.links, 1);
        assert!(destination.join("media/movies/film.mkv").exists());

        remove_old_data(&source).unwrap();
        assert!(source.exists());
        assert_eq!(source.read_dir().unwrap().count(), 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn scan_counts_files_directories_and_symlinks() {
        let (root, source, _) = fixture("scan");
        symlink("media/movies/film.mkv", source.join("link")).unwrap();
        let stats = scan_tree(&source).unwrap();
        assert_eq!(stats.files, 1);
        assert_eq!(stats.directories, 3);
        assert_eq!(stats.links, 1);
        assert_eq!(stats.bytes, 6);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verify_rejects_a_truncated_file() {
        let (root, source, destination) = fixture("truncated");
        copy(&source, &destination, &mut |_| {}).unwrap();
        fs::write(destination.join("media/movies/film.mkv"), b"1").unwrap();
        assert!(verify_tree(&source, &destination).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn env_update_keeps_other_keys_and_can_be_restored() {
        let (root, _, destination) = fixture("envs");
        let stacks = installed_stacks(&root);
        let backups = write_envs(
            &root,
            &stacks,
            StorageTarget::Download,
            &destination,
            1001,
            1002,
        )
        .unwrap();

        for stack in &stacks {
            let env = envfile::read(&env_path(&root, *stack));
            assert_eq!(
                env.get("DOWNLOAD_DIR").map(String::as_str),
                Some(destination.to_string_lossy().as_ref())
            );
            assert!(
                !env.contains_key("DATA_DIR"),
                "the legacy key must not survive the rename"
            );
            assert_eq!(env.get("PUID").map(String::as_str), Some("1001"));
            assert_eq!(env.get("PGID").map(String::as_str), Some("1002"));
            assert_eq!(env.get("KEEP").map(String::as_str), Some("yes"));
            assert!(env_path(&root, *stack).with_file_name(ENV_BACKUP).is_file());
        }

        restore_envs(&backups).unwrap();
        for stack in &stacks {
            let env = envfile::read(&env_path(&root, *stack));
            assert_eq!(env.get("PUID").map(String::as_str), Some("1000"));
            assert_eq!(env.get("KEEP").map(String::as_str), Some("yes"));
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// The default layout puts media inside the download directory, so a
    /// `--move` that rewrote only `DOWNLOAD_DIR` would delete the media tree and
    /// leave `.env` pointing at the path it just removed.
    #[test]
    fn relocating_the_download_directory_carries_a_nested_media_directory() {
        let (root, _, destination) = fixture("relocate-media");
        let stacks = installed_stacks(&root);
        let before = envfile::read(&env_path(&root, Stack::Server));
        assert_eq!(
            before.get("MEDIA_DIR"),
            None,
            "the fixture stores no media key"
        );
        let old_download = before.get("DOWNLOAD_DIR").cloned().unwrap();

        write_envs(
            &root,
            &stacks,
            StorageTarget::Download,
            &destination,
            1001,
            1002,
        )
        .unwrap();

        for stack in &stacks {
            let env = envfile::read(&env_path(&root, *stack));
            let media = env.get("MEDIA_DIR").expect("MEDIA_DIR must be written");
            assert_eq!(
                media,
                &format!("{}/media", destination.display()),
                "media nested in the old download directory must follow it"
            );
            assert!(
                !media.starts_with(&old_download),
                "the rewritten media path must not point into the directory --move deletes"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// A media move touches `MEDIA_DIR` only: the download directory, and
    /// therefore every in-flight torrent, keeps pointing where it was.
    #[test]
    fn relocating_the_media_directory_leaves_downloads_alone() {
        let (root, source, destination) = fixture("relocate-media-only");
        let stacks = installed_stacks(&root);
        let download = format!("{}/incomplete", source.display());
        for stack in &stacks {
            envfile::upsert(&env_path(&root, *stack), "DOWNLOAD_DIR", &download).unwrap();
            envfile::upsert(
                &env_path(&root, *stack),
                "MEDIA_DIR",
                &format!("{}/media", source.display()),
            )
            .unwrap();
        }
        fs::create_dir_all(source.join("media")).unwrap();

        let plan = plan(&root, &stacks, StorageTarget::Media, &destination, false).unwrap();
        assert_eq!(plan.target, StorageTarget::Media);
        assert_eq!(plan.source, fs::canonicalize(source.join("media")).unwrap());
        assert_eq!(plan.total_bytes, 6, "only the library is counted");

        write_envs(
            &root,
            &stacks,
            StorageTarget::Media,
            &destination,
            1001,
            1002,
        )
        .unwrap();

        for stack in &stacks {
            let env = envfile::read(&env_path(&root, *stack));
            assert_eq!(
                env.get("MEDIA_DIR").map(String::as_str),
                Some(destination.to_string_lossy().as_ref())
            );
            assert_eq!(
                env.get("DOWNLOAD_DIR").map(String::as_str),
                Some(download.as_str()),
                "a media move must not disturb the download directory"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    /// A download move carries the library with it, so the pair stays on one
    /// filesystem and imports keep hardlinking.
    #[test]
    fn a_download_move_never_splits_imports() {
        let (root, _, destination) = fixture("splits-download");
        let stacks = installed_stacks(&root);
        let plan = plan(&root, &stacks, StorageTarget::Download, &destination, false).unwrap();
        assert!(!plan.splits_imports);
        fs::remove_dir_all(root).unwrap();
    }

    /// A library on its own disk must not be rewritten or moved.
    #[test]
    fn relocating_leaves_a_media_directory_outside_the_download_directory_alone() {
        let (root, _, destination) = fixture("relocate-media-outside");
        let stacks = installed_stacks(&root);
        for stack in &stacks {
            envfile::upsert(&env_path(&root, *stack), "MEDIA_DIR", "/mnt/library").unwrap();
        }

        write_envs(
            &root,
            &stacks,
            StorageTarget::Download,
            &destination,
            1001,
            1002,
        )
        .unwrap();

        for stack in &stacks {
            let env = envfile::read(&env_path(&root, *stack));
            assert_eq!(
                env.get("MEDIA_DIR").map(String::as_str),
                Some("/mnt/library")
            );
            assert_eq!(
                env.get("DOWNLOAD_DIR").map(String::as_str),
                Some(destination.to_string_lossy().as_ref())
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn progress(line: &str) -> Progress2 {
        parse_progress2(line).unwrap_or_else(|| panic!("not progress: {line:?}"))
    }

    #[test]
    fn progress_frames_are_parsed_with_their_file_counts() {
        let frame = progress("    1,234,567  45%    3.00GB/s    0:00:12 (xfr#12, to-chk=48/60)");
        assert_eq!(
            frame,
            Progress2 {
                bytes: 1_234_567,
                percent: 45,
                rate: "3.00GB/s".to_string(),
                eta: "0:00:12".to_string(),
                files_done: 12,
                files_left: 48,
                files_total: 60,
            }
        );
    }

    #[test]
    fn progress_frames_without_file_counts_keep_zeroes() {
        let frame = progress("0   0%    0.00kB/s    0:00:00");
        assert_eq!(frame.bytes, 0);
        assert_eq!(frame.percent, 0);
        assert_eq!(frame.files_total, 0);

        // The final frame rsync emits for a fully skipped resume.
        let frame = progress("0 100%    0.00kB/s    0:00:00 (xfr#0, to-chk=0/0)");
        assert_eq!(frame.percent, 100);
        assert_eq!(frame.files_total, 0);
    }

    #[test]
    fn progress_survives_a_resumed_copy_finishing_early() {
        let frame = progress("      2,097,152 100%    1.92GB/s    0:00:00 (xfr#1, to-chk=0/3)");
        assert_eq!(frame.bytes, 2_097_152);
        assert_eq!(frame.percent, 100);
    }

    #[test]
    fn non_progress_output_is_never_mistaken_for_progress() {
        for line in [
            "",
            "deleting media/movies/film.mkv",
            "skipping directory incomplete",
            "sending incremental file list",
            "sent 41,943,040 bytes  received 35 bytes  83,886,150.00 bytes/sec",
            "total size is 41,943,040  speedup is 1.00",
            "rsync: [sender] read errors mapping \"/data/a.mkv\": Input/output error (5)",
            "rsync error: some files/attrs were not transferred (code 23) at main.c:1",
            "0000 50% 1.00MB/s not-a-time",
            "123 101% 1.00MB/s 0:00:00",
            "123 45 1.00MB/s 0:00:00",
        ] {
            assert!(
                parse_progress2(line).is_none(),
                "{line:?} parsed as progress"
            );
        }
    }

    #[test]
    fn copy_reports_progress_and_passes_other_lines_through() {
        let (root, source, destination) = fixture("events");
        let mut seen: Vec<String> = Vec::new();
        copy(&source, &destination, &mut |event| match event {
            CopyEvent::Progress(progress) => seen.push(format!("progress {}", progress.percent)),
            CopyEvent::Line(line) => seen.push(format!("line {line}")),
        })
        .unwrap();
        // rsync reports progress; cp -a in the fallback does not. Only assert
        // the split is consistent with whichever engine ran.
        if system::which("rsync") {
            assert!(
                seen.iter().any(|entry| entry.starts_with("progress ")),
                "rsync produced no progress events: {seen:?}"
            );
        } else {
            assert!(seen.iter().all(|entry| entry.starts_with("line ")));
        }
        assert!(destination.join("media/movies/film.mkv").is_file());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copy_failures_from_read_errors_explain_corruption() {
        let tail = vec![
            "rsync: [sender] read errors mapping \"/data/a.mkv\": Input/output error (5)"
                .to_string(),
            "ERROR: a.mkv failed verification -- update discarded.".to_string(),
            "rsync error: some files/attrs were not transferred (see previous errors) (code 23)"
                .to_string(),
        ];
        let message = copy_failure_explanation(Some(23), &tail).unwrap();
        assert!(message.contains("bad data"));
        assert!(message.contains("matching sizes do not prove"));
        assert!(message.contains("old .env is unchanged"));
    }

    #[test]
    fn copy_failures_without_read_errors_stay_generic() {
        let tail = vec!["rsync: permission denied".to_string()];
        let message = copy_failure_explanation(Some(23), &tail).unwrap();
        assert!(message.contains("code 23"));
        assert!(message.contains("not necessarily"));
        assert!(copy_failure_explanation(Some(1), &tail).is_none());
    }

    #[test]
    fn human_sizes_are_readable() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(1023), "1023 B");
        assert_eq!(format_bytes(1024), "1.0 KiB");
        assert_eq!(format_bytes(1024 * 1024 * 3 / 2), "1.5 MiB");
    }
}
