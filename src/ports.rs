//! Host ports churn publishes, and the rules for moving them when something
//! else already owns the default.
//!
//! A port's default is the conventional target port. Only the host side moves;
//! the container keeps listening on its internal port unless the port is also
//! the listener (the dashboard and the VPN status agent).

use std::net::TcpListener;

use crate::stack::Stack;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Port {
    Jellyfin,
    Sonarr,
    Radarr,
    Dashboard,
    Qbittorrent,
    Prowlarr,
    VpnStatus,
}

impl Port {
    pub const ALL: [Port; 7] = [
        Port::Jellyfin,
        Port::Sonarr,
        Port::Radarr,
        Port::Dashboard,
        Port::Qbittorrent,
        Port::Prowlarr,
        Port::VpnStatus,
    ];

    pub fn default_port(self) -> u16 {
        match self {
            Port::Jellyfin => 8096,
            Port::Sonarr => 8989,
            Port::Radarr => 7878,
            Port::Dashboard => 4000,
            Port::Qbittorrent => 8080,
            Port::Prowlarr => 9696,
            Port::VpnStatus => 8098,
        }
    }

    pub fn env_key(self) -> &'static str {
        match self {
            Port::Jellyfin => "JELLYFIN_PORT",
            Port::Sonarr => "SONARR_PORT",
            Port::Radarr => "RADARR_PORT",
            Port::Dashboard => "DASHBOARD_PORT",
            Port::Qbittorrent => "QBITTORRENT_PORT",
            Port::Prowlarr => "PROWLARR_PORT",
            Port::VpnStatus => "VPN_STATUS_PORT",
        }
    }

    pub fn service_name(self) -> &'static str {
        match self {
            Port::Jellyfin => "Jellyfin",
            Port::Sonarr => "Sonarr",
            Port::Radarr => "Radarr",
            Port::Dashboard => "Dashboard",
            Port::Qbittorrent => "qBittorrent",
            Port::Prowlarr => "Prowlarr",
            Port::VpnStatus => "VPN status",
        }
    }

    /// Compose service that publishes this port. Prowlarr, qBittorrent and
    /// the VPN status agent all share gluetun's network namespace, so gluetun
    /// is the service Docker reports their published ports on.
    pub fn compose_service(self) -> &'static str {
        match self {
            Port::Jellyfin => "jellyfin",
            Port::Sonarr => "sonarr",
            Port::Radarr => "radarr",
            Port::Dashboard => "dashboard",
            Port::Qbittorrent | Port::Prowlarr | Port::VpnStatus => "gluetun",
        }
    }

    /// Container-side port for fixed mappings. The dashboard and VPN status
    /// agent listen on the same port they publish, so their target is dynamic.
    pub fn target_port(self) -> Option<u16> {
        match self {
            Port::Dashboard | Port::VpnStatus => None,
            _ => Some(self.default_port()),
        }
    }

    /// Host port already published by an existing churn container, if any.
    pub fn published_in(self, services: &[crate::compose::PsService]) -> Option<u16> {
        services
            .iter()
            .filter(|service| service.service == self.compose_service())
            .flat_map(|service| &service.publishers)
            .find(|publisher| {
                publisher.published_port != 0
                    && (publisher.protocol.is_empty()
                        || publisher.protocol.eq_ignore_ascii_case("tcp"))
                    && match self {
                        Port::Dashboard => true,
                        Port::VpnStatus => {
                            publisher.url.starts_with("127.")
                                || publisher.url == "::1"
                                || publisher.url.starts_with("[::1]")
                        }
                        _ => Some(publisher.target_port) == self.target_port(),
                    }
            })
            .map(|publisher| publisher.published_port)
    }

    pub fn label(self) -> &'static str {
        match self {
            Port::Jellyfin => "Host port for the Jellyfin web UI",
            Port::Sonarr => "Host port for the Sonarr web UI",
            Port::Radarr => "Host port for the Radarr web UI",
            Port::Dashboard => "Host port for the churn dashboard",
            Port::Qbittorrent => "Host port for the qBittorrent web UI",
            Port::Prowlarr => "Host port for the Prowlarr web UI",
            Port::VpnStatus => "Host port for the VPN status agent (loopback only)",
        }
    }

    pub fn stack(self) -> Stack {
        match self {
            Port::Jellyfin | Port::Sonarr | Port::Radarr | Port::Dashboard => Stack::Server,
            Port::Qbittorrent | Port::Prowlarr | Port::VpnStatus => Stack::Torrent,
        }
    }

    /// Address the host port will bind. Docker publishes most ports on all
    /// interfaces; the VPN status agent is deliberately loopback-only.
    pub fn bind_address(self) -> &'static str {
        match self {
            Port::VpnStatus => "127.0.0.1",
            _ => "0.0.0.0",
        }
    }

    pub fn is_free(self, port: u16) -> bool {
        TcpListener::bind((self.bind_address(), port)).is_ok()
    }
}

pub fn validate_port(value: &str) -> Result<u16, String> {
    let port: u16 = value
        .parse()
        .map_err(|_| "Enter a port number between 1024 and 65535.".to_string())?;
    if !(1024..=65535).contains(&port) {
        return Err("Use an unprivileged port between 1024 and 65535.".to_string());
    }
    Ok(port)
}

/// Scan upward from the default, then downward, for the first port that is not
/// reserved and can be bound. Upward-first keeps the common case predictable:
/// 8080 taken -> 8081, not 8079.
pub fn nearest_free(default: u16, reserved: &[u16], port: Port) -> u16 {
    nearest_free_with(default, reserved, |candidate| port.is_free(candidate))
}

fn nearest_free_with(default: u16, reserved: &[u16], is_free: impl Fn(u16) -> bool) -> u16 {
    let upwards = default..=u16::MAX;
    let downwards = (1024..default).rev();
    upwards
        .chain(downwards)
        .find(|candidate| !reserved.contains(candidate) && is_free(*candidate))
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_defaults_are_distinct() {
        let mut ports: Vec<u16> = Port::ALL.iter().map(|port| port.default_port()).collect();
        ports.sort_unstable();
        ports.dedup();
        assert_eq!(ports.len(), Port::ALL.len());
    }

    #[test]
    fn validation_rejects_privileged_and_invalid_ports() {
        assert!(validate_port("8080").is_ok());
        assert!(validate_port("1024").is_ok());
        assert!(validate_port("80").is_err());
        assert!(validate_port("70000").is_err());
        assert!(validate_port("http").is_err());
    }

    #[test]
    fn nearest_free_skips_reserved_ports() {
        let reserved = [8080, 8081, 8082];
        let found = nearest_free_with(8080, &reserved, |port| port == 8083);
        assert_eq!(found, 8083);
    }

    #[test]
    fn nearest_free_wraps_below_only_after_scanning_up() {
        let found = nearest_free_with(8080, &[8080], |port| port == 8079);
        assert_eq!(found, 8079);
    }

    #[test]
    fn existing_published_ports_are_matched_by_service_and_target() {
        use crate::compose::{PsPublisher, PsService};

        let services = vec![
            PsService {
                service: "gluetun".to_string(),
                publishers: vec![
                    PsPublisher {
                        url: "0.0.0.0".to_string(),
                        target_port: 8080,
                        published_port: 8081,
                        protocol: "tcp".to_string(),
                    },
                    PsPublisher {
                        url: "0.0.0.0".to_string(),
                        target_port: 9696,
                        published_port: 9697,
                        protocol: "tcp".to_string(),
                    },
                    PsPublisher {
                        url: "127.0.0.1".to_string(),
                        target_port: 8098,
                        published_port: 8098,
                        protocol: "tcp".to_string(),
                    },
                ],
            },
            PsService {
                service: "jellyfin".to_string(),
                publishers: vec![PsPublisher {
                    url: "0.0.0.0".to_string(),
                    target_port: 8096,
                    published_port: 8096,
                    protocol: "tcp".to_string(),
                }],
            },
        ];

        assert_eq!(Port::Qbittorrent.published_in(&services), Some(8081));
        assert_eq!(Port::Prowlarr.published_in(&services), Some(9697));
        assert_eq!(Port::VpnStatus.published_in(&services), Some(8098));
        assert_eq!(Port::Jellyfin.published_in(&services), Some(8096));
        assert_eq!(Port::Sonarr.published_in(&services), None);
    }
}
