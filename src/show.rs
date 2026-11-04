//! `churn show`: print the URLs where the installed services listen.

use std::path::Path;

use crate::envfile;
use crate::ports::{self, Port};
use crate::stack::Stack;

const SHOW_ORDER: [Port; 7] = [
    Port::Dashboard,
    Port::Jellyfin,
    Port::Sonarr,
    Port::Radarr,
    Port::Qbittorrent,
    Port::Prowlarr,
    Port::VpnStatus,
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Service {
    pub name: &'static str,
    pub url: String,
}

/// Stacks that have generated state. In a checkout both stack directories and
/// compose files exist even when only one stack was installed, so the `.env`
/// written by the installer is the reliable marker.
pub fn installed(root: &Path, chosen: &[Stack]) -> Vec<Stack> {
    Stack::ALL
        .into_iter()
        .filter(|stack| chosen.contains(stack))
        .filter(|stack| root.join(stack.key()).join(".env").is_file())
        .collect()
}

/// Best address to hand to a person opening the service from another machine.
/// Explicit `CHURN_HOST_IP` wins, then the value the installer persisted for
/// gluetun, then normal route detection.
pub fn host_ip(root: &Path) -> String {
    if let Ok(ip) = std::env::var("CHURN_HOST_IP") {
        let ip = ip.trim();
        if !ip.is_empty() {
            return ip.to_string();
        }
    }
    let stored = envfile::read(&root.join(Stack::Torrent.key()).join(".env"));
    if let Some(ip) = stored
        .get("HOST_IP")
        .map(|value| value.trim())
        .filter(|ip| !ip.is_empty())
    {
        return ip.to_string();
    }
    envfile::host_ip()
}

pub fn services(root: &Path, chosen: &[Stack], host_ip: &str) -> Vec<Service> {
    let host = url_host(host_ip);
    let mut services = Vec::new();
    for stack in installed(root, chosen) {
        for port in SHOW_ORDER.into_iter().filter(|port| port.stack() == stack) {
            let number = configured_port(root, port);
            let host = if port.bind_address() == "127.0.0.1" {
                "127.0.0.1"
            } else {
                &host
            };
            services.push(Service {
                name: port.service_name(),
                url: format!("http://{host}:{number}"),
            });
        }
    }
    services
}

fn configured_port(root: &Path, port: Port) -> u16 {
    let owner = root.join(port.stack().key()).join(".env");
    let other = root.join(port.stack().other().key()).join(".env");
    [owner, other]
        .into_iter()
        .find_map(|path| {
            envfile::read(&path)
                .get(port.env_key())
                .and_then(|value| ports::validate_port(value).ok())
        })
        .unwrap_or_else(|| port.default_port())
}

fn url_host(ip: &str) -> String {
    if ip.contains(':') {
        format!("[{ip}]")
    } else {
        ip.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("churn-show-{}-{label}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_env(root: &Path, stack: Stack, body: &str) {
        let dir = root.join(stack.key());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".env"), body).unwrap();
    }

    #[test]
    fn only_installed_stacks_are_listed() {
        let root = temp_root("installed");
        write_env(
            &root,
            Stack::Server,
            "DASHBOARD_PORT=4100\nJELLYFIN_PORT=8196\n",
        );

        let found = services(&root, &Stack::ALL, "192.168.1.20");
        assert_eq!(
            found,
            vec![
                Service {
                    name: "Dashboard",
                    url: "http://192.168.1.20:4100".to_string()
                },
                Service {
                    name: "Jellyfin",
                    url: "http://192.168.1.20:8196".to_string()
                },
                Service {
                    name: "Sonarr",
                    url: "http://192.168.1.20:8989".to_string()
                },
                Service {
                    name: "Radarr",
                    url: "http://192.168.1.20:7878".to_string()
                },
            ]
        );
    }

    #[test]
    fn the_explicit_stack_filter_is_honored() {
        let root = temp_root("filter");
        write_env(&root, Stack::Server, "");
        write_env(&root, Stack::Torrent, "QBITTORRENT_PORT=8081\n");

        let found = services(&root, &[Stack::Torrent], "192.168.1.20");
        assert_eq!(found[0].url, "http://192.168.1.20:8081");
        assert!(found.iter().all(|service| service.name != "Jellyfin"));
    }

    #[test]
    fn vpn_status_stays_on_loopback() {
        let root = temp_root("loopback");
        write_env(&root, Stack::Torrent, "");

        let found = services(&root, &[Stack::Torrent], "192.168.1.20");
        let status = found
            .iter()
            .find(|service| service.name == "VPN status")
            .unwrap();
        assert_eq!(status.url, "http://127.0.0.1:8098");
    }

    #[test]
    fn ipv6_hosts_are_bracketed() {
        assert_eq!(url_host("2001:db8::1"), "[2001:db8::1]");
        assert_eq!(url_host("192.168.1.20"), "192.168.1.20");
    }
}
