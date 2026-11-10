//! Stack files compiled into the installer.
//!
//! A released churn binary runs on a machine with no source checkout, but
//! `docker compose` still needs the compose files and the scripts they mount.
//! These assets are embedded with `include_str!` and written to the stack root
//! on every install/rerun, so they always match the installed binary.

use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use crate::stack::Stack;

pub struct Asset {
    /// Path relative to the stack root, matching the compose bind mounts.
    pub path: &'static str,
    pub body: &'static str,
    pub mode: u32,
}

const SERVER_ASSETS: &[Asset] = &[
    Asset {
        path: "docker-compose.yml",
        body: include_str!("../server/docker-compose.yml"),
        mode: 0o644,
    },
    Asset {
        path: "scripts/server-init.sh",
        body: include_str!("../server/scripts/server-init.sh"),
        mode: 0o755,
    },
];

const TORRENT_ASSETS: &[Asset] = &[
    Asset {
        path: "docker-compose.yml",
        body: include_str!("../torrent/docker-compose.yml"),
        mode: 0o644,
    },
    Asset {
        path: "resolv.conf",
        body: include_str!("../torrent/resolv.conf"),
        mode: 0o644,
    },
    Asset {
        path: "scripts/prowlarr-init.sh",
        body: include_str!("../torrent/scripts/prowlarr-init.sh"),
        mode: 0o755,
    },
    Asset {
        path: "scripts/qbittorrent-init.sh",
        body: include_str!("../torrent/scripts/qbittorrent-init.sh"),
        mode: 0o755,
    },
    Asset {
        path: "scripts/qbit-watch.sh",
        body: include_str!("../torrent/scripts/qbit-watch.sh"),
        mode: 0o755,
    },
    Asset {
        path: "scripts/vpn-check.sh",
        body: include_str!("../torrent/scripts/vpn-check.sh"),
        mode: 0o755,
    },
    Asset {
        path: "scripts/vpn-lib.sh",
        body: include_str!("../torrent/scripts/vpn-lib.sh"),
        mode: 0o755,
    },
    Asset {
        path: "scripts/vpn-status.sh",
        body: include_str!("../torrent/scripts/vpn-status.sh"),
        mode: 0o755,
    },
];

pub fn for_stack(stack: Stack) -> &'static [Asset] {
    match stack {
        Stack::Server => SERVER_ASSETS,
        Stack::Torrent => TORRENT_ASSETS,
    }
}

/// Write the stack's compose file and scripts under `root/<stack>/`.
///
/// Existing files are replaced; the `.env` and generated config are untouched.
pub fn materialize(root: &Path, stack: Stack) -> io::Result<()> {
    let base = root.join(stack.key());
    for asset in for_stack(stack) {
        write_asset(&base, asset)?;
    }
    Ok(())
}

fn write_asset(base: &Path, asset: &Asset) -> io::Result<()> {
    let path = base.join(asset.path);
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other(format!("asset {} has no parent", asset.path)))?;
    fs::create_dir_all(parent)?;

    // Replace atomically so a running stack never reads a half-written script.
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .ok_or_else(|| io::Error::other(format!("asset {} has no file name", asset.path)))?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));

    let result = (|| {
        fs::write(&temporary, asset.body)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(asset.mode))?;
        fs::rename(&temporary, &path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("churn-assets-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn every_stack_asset_lands_with_the_expected_content_and_mode() {
        for (index, stack) in Stack::ALL.into_iter().enumerate() {
            let root = temp_root(&index.to_string());
            materialize(&root, stack).unwrap();

            for asset in for_stack(stack) {
                let path = root.join(stack.key()).join(asset.path);
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    asset.body,
                    "{} content",
                    asset.path
                );
                let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, asset.mode, "{} mode", asset.path);
            }

            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn rerunning_replaces_modified_stack_files() {
        let root = temp_root("replace");
        materialize(&root, Stack::Server).unwrap();
        let compose = root.join("server/docker-compose.yml");
        fs::write(&compose, "hand edited\n").unwrap();

        materialize(&root, Stack::Server).unwrap();

        assert_eq!(
            fs::read_to_string(&compose).unwrap(),
            for_stack(Stack::Server)[0].body
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn asset_paths_stay_inside_the_stack_root() {
        for stack in Stack::ALL {
            for asset in for_stack(stack) {
                let path = Path::new(asset.path);
                assert!(path.is_relative(), "{} must be relative", asset.path);
                assert!(
                    !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir)),
                    "{} must not escape the stack root",
                    asset.path
                );
            }
        }
    }
}
