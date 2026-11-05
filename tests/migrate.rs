//! End-to-end checks for the rsync progress plumbing that unit tests cannot
//! reach: a fake `rsync` on `PATH` proves the frames reach the callback and that
//! progress never crowds the rsync complaint out of the failure message.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;

use churn::migrate::{self, CopyEvent};

struct PathGuard(Option<std::ffi::OsString>);

impl PathGuard {
    /// Prepend `dir` to `PATH` for the lifetime of the guard.
    fn prepend(dir: &std::path::Path) -> Self {
        let original = std::env::var_os("PATH");
        let joined = match &original {
            Some(path) => format!("{}:{}", dir.display(), path.to_string_lossy()),
            None => dir.display().to_string(),
        };
        // Safe here: this binary runs a single test, so nothing else reads PATH.
        unsafe { std::env::set_var("PATH", joined) };
        Self(original)
    }
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        unsafe {
            match self.0.take() {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}

fn fixture(label: &str) -> (PathBuf, PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("churn-migrate-{label}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let bin = dir.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let source = dir.join("src");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("a.mkv"), b"data").unwrap();
    (dir, bin, source)
}

#[test]
fn fake_rsync_frames_reach_the_callback_and_stay_out_of_the_error() {
    let (dir, bin, source) = fixture("fake-rsync");
    let destination = dir.join("dst");
    let script = bin.join("rsync");
    fs::write(
        &script,
        "#!/bin/sh\n\
         # Percent signs are printf format characters, so pass frames as arguments.\n\
         printf '%s\\r' '      1,024  10%    1.00MB/s    0:00:09'\n\
         printf '%s\\r' '  1,024,000  55%    9.00MB/s    0:00:04 (xfr#5, to-chk=3/9)'\n\
         printf '%s\\n' 'rsync: [sender] read errors mapping \"/data/a.mkv\": Input/output error (5)'\n\
         exit 23\n",
    )
    .unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();

    let _guard = PathGuard::prepend(&bin);
    let mut progress = Vec::new();
    let mut lines = Vec::new();
    let error = migrate::copy(&source, &destination, &mut |event| match event {
        CopyEvent::Progress(frame) => progress.push(frame),
        CopyEvent::Line(line) => lines.push(line.to_string()),
    })
    .unwrap_err();

    assert_eq!(
        progress
            .iter()
            .map(|frame| (frame.bytes, frame.percent, frame.files_total))
            .collect::<Vec<_>>(),
        vec![(1024, 10, 0), (1_024_000, 55, 9)],
        "frames: {progress:?}, lines: {lines:?}"
    );
    assert!(
        lines.iter().any(|line| line.contains("read errors")),
        "the rsync complaint never reached the callback: {lines:?}"
    );

    let message = error.to_string();
    assert!(
        !message.contains("1,024,000"),
        "progress frames leaked into the failure message: {message}"
    );
    assert!(
        message.contains("read errors") && message.contains("bad data"),
        "the failure lost its rsync detail or explanation: {message}"
    );
    fs::remove_dir_all(&dir).unwrap();
}
