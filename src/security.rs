//! Safety checks for the torrent stack's VPN boundary.
//!
//! The compose file is static, but environment values can change what Docker
//! actually creates. `docker compose config --format json` gives the effective
//! configuration; these checks reject any service that could get a network path
//! around Gluetun's kill switch.

use serde_json::{Map, Value};

const GLUETUN: &str = "gluetun";
const GLUETUN_NETNS: &str = "service:gluetun";
const FILTERED_NETWORK: &str = "none";
const GLUETUN_DNS: &str = "127.0.0.1";
const FIREWALL_ENABLED: &str = "FIREWALL_ENABLED_DISABLING_IT_SHOOTS_YOU_IN_YOUR_FOOT";

/// Validate the effective `docker compose config --format json` for the
/// torrent stack. Returns every problem found instead of stopping at the first.
pub fn verify_torrent_isolation(config: &Value) -> Result<(), Vec<String>> {
    let Some(services) = config.get("services").and_then(Value::as_object) else {
        return Err(vec!["compose config has no services".to_string()]);
    };
    let Some(gluetun) = services.get(GLUETUN) else {
        return Err(vec!["the torrent stack has no gluetun service".to_string()]);
    };

    let mut problems = Vec::new();
    check_gluetun(gluetun, &mut problems);
    check_vpn_gate(services, &mut problems);

    for (name, service) in services {
        if name != GLUETUN {
            check_sidecar(name, service, &mut problems);
        }
    }

    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems)
    }
}

fn check_gluetun(service: &Value, problems: &mut Vec<String>) {
    if service.get("network_mode").is_some() {
        problems.push(format!(
            "gluetun must use its own network namespace, not network_mode"
        ));
    }
    if is_true(service.get("privileged")) {
        problems.push("gluetun must not be privileged".to_string());
    }
    if let Some(networks) = service.get("networks").and_then(Value::as_object)
        && networks.keys().any(|name| name != "default")
    {
        problems.push(format!(
            "gluetun must only join the default Compose network, found {:?}",
            networks.keys().collect::<Vec<_>>()
        ));
    }

    let env = service
        .get("environment")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if env_str(&env, "VPN_SERVICE_PROVIDER") != Some("mullvad") {
        problems.push("gluetun must use VPN_SERVICE_PROVIDER=mullvad".to_string());
    }
    if env_str(&env, "VPN_TYPE") != Some("wireguard") {
        problems.push("gluetun must use VPN_TYPE=wireguard".to_string());
    }
    if !truthy(env_str(&env, FIREWALL_ENABLED)) {
        problems.push(format!("gluetun must explicitly set {FIREWALL_ENABLED}=on"));
    }
    check_firewall_exceptions(env_str(&env, "FIREWALL_OUTBOUND_SUBNETS"), problems);

    if !truthy(env_str(&env, "DNS_SERVER")) {
        problems.push("gluetun must keep DNS_SERVER=on".to_string());
    }
    if env_str(&env, "DNS_ADDRESS") != Some(GLUETUN_DNS) {
        problems.push(format!(
            "gluetun must set DNS_ADDRESS={GLUETUN_DNS} so sidecars use its resolver"
        ));
    }
    if truthy(env_str(&env, "DNS_KEEP_NAMESERVER")) {
        problems.push("DNS_KEEP_NAMESERVER must be off to prevent DNS leaks".to_string());
    }
    if env_str(&env, "DNS_UPSTREAM_RESOLVER_TYPE") == Some("plain") {
        problems.push("DNS_UPSTREAM_RESOLVER_TYPE must not be plaintext".to_string());
    }

    let ipv6_disabled = service
        .get("sysctls")
        .and_then(Value::as_object)
        .and_then(|sysctls| sysctls.get("net.ipv6.conf.all.disable_ipv6"))
        .is_some_and(|value| value.as_i64() == Some(1) || value.as_str() == Some("1"));
    if !ipv6_disabled {
        problems.push(
            "gluetun must disable IPv6 in the shared namespace (net.ipv6.conf.all.disable_ipv6=1)"
                .to_string(),
        );
    }
}

fn check_sidecar(name: &str, service: &Value, problems: &mut Vec<String>) {
    let mode = service.get("network_mode").and_then(Value::as_str);
    if !matches!(mode, Some(GLUETUN_NETNS) | Some(FILTERED_NETWORK)) {
        problems.push(format!(
            "{name} must use network_mode: \"{GLUETUN_NETNS}\" or \"{FILTERED_NETWORK}\", found {mode:?}"
        ));
        return;
    }

    if is_true(service.get("privileged")) {
        problems.push(format!("{name} must not be privileged"));
    }
    if service.get("dns").is_some() {
        problems.push(format!(
            "{name} cannot set dns with network_mode; mount torrent/resolv.conf at /etc/resolv.conf instead"
        ));
    }
    if service
        .get("ports")
        .and_then(Value::as_array)
        .is_some_and(|ports| !ports.is_empty())
    {
        problems.push(format!(
            "{name} must not publish ports itself; publish them on gluetun"
        ));
    }
    if service
        .get("networks")
        .and_then(Value::as_object)
        .is_some_and(|networks| !networks.is_empty())
    {
        problems.push(format!(
            "{name} must not join a separate Docker network; share gluetun's namespace"
        ));
    }

    if mode == Some(GLUETUN_NETNS) && !has_gluetun_resolv_mount(service) {
        problems.push(format!(
            "{name} must mount the static Gluetun resolv.conf at /etc/resolv.conf"
        ));
    }
}

fn has_gluetun_resolv_mount(service: &Value) -> bool {
    has_read_only_mount(service, "/etc/resolv.conf", "/torrent/resolv.conf")
}

fn has_read_only_mount(service: &Value, target: &str, source_suffix: &str) -> bool {
    service
        .get("volumes")
        .and_then(Value::as_array)
        .is_some_and(|volumes| {
            volumes.iter().any(|volume| {
                volume.get("target").and_then(Value::as_str) == Some(target)
                    && volume.get("read_only").and_then(Value::as_bool) == Some(true)
                    && volume
                        .get("source")
                        .and_then(Value::as_str)
                        .is_some_and(|source| source.ends_with(source_suffix))
            })
        })
}

fn check_vpn_gate(services: &Map<String, Value>, problems: &mut Vec<String>) {
    let Some(vpn_check) = services.get("vpn-check") else {
        problems.push("the torrent stack has no vpn-check fail-closed gate".to_string());
        return;
    };
    if !has_read_only_mount(
        vpn_check,
        "/scripts/vpn-check.sh",
        "/torrent/scripts/vpn-check.sh",
    ) {
        problems.push("vpn-check must mount its check script read-only".to_string());
    }

    for (name, service) in services {
        if matches!(name.as_str(), GLUETUN | "vpn-check" | "qbittorrent-init") {
            continue;
        }
        if service.get("network_mode").and_then(Value::as_str) == Some(GLUETUN_NETNS)
            && !waits_for_vpn_check(service)
        {
            problems.push(format!(
                "{name} must wait for vpn-check with condition service_completed_successfully"
            ));
        }
    }
}

fn waits_for_vpn_check(service: &Value) -> bool {
    service
        .get("depends_on")
        .and_then(Value::as_object)
        .and_then(|dependencies| dependencies.get("vpn-check"))
        .and_then(|dependency| dependency.get("condition"))
        .and_then(Value::as_str)
        == Some("service_completed_successfully")
}

fn check_firewall_exceptions(value: Option<&str>, problems: &mut Vec<String>) {
    let Some(value) = value else {
        problems.push("FIREWALL_OUTBOUND_SUBNETS is required".to_string());
        return;
    };

    let exceptions: Vec<&str> = value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if exceptions.is_empty() {
        problems.push("FIREWALL_OUTBOUND_SUBNETS must allow only the server host".to_string());
        return;
    }

    for exception in exceptions {
        let Some((address, prefix)) = exception.split_once('/') else {
            problems.push(format!(
                "FIREWALL_OUTBOUND_SUBNETS entry {exception:?} must be a CIDR"
            ));
            continue;
        };
        if address == "0.0.0.0" || address == "::" {
            problems.push(format!(
                "FIREWALL_OUTBOUND_SUBNETS must not allow the whole internet: {exception}"
            ));
            continue;
        }
        if !matches!(prefix, "32" | "128") {
            problems.push(format!(
                "FIREWALL_OUTBOUND_SUBNETS must be a single host (/32 or /128), found {exception}"
            ));
        }
        if !is_local_ipv4(address) {
            problems.push(format!(
                "FIREWALL_OUTBOUND_SUBNETS may only exempt a loopback/LAN host, found {exception}"
            ));
        }
    }
}

/// True for IPv4 addresses that cannot be a public internet destination:
/// loopback, RFC1918 private ranges, link-local and CGNAT.
pub fn is_local_ipv4(address: &str) -> bool {
    let octets: Vec<u8> = address
        .split('.')
        .map(|part| part.parse::<u8>())
        .collect::<Result<_, _>>()
        .unwrap_or_default();
    let [a, b, ..] = octets.as_slice() else {
        return false;
    };
    matches!(
        (*a, *b),
        (10, _) | (127, _) | (169, 254) | (172, 16..=31) | (192, 168) | (100, 64..=127)
    )
}

fn env_str<'a>(env: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    env.get(key).and_then(Value::as_str)
}

fn truthy(value: Option<&str>) -> bool {
    matches!(
        value.map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn is_true(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.as_bool() == Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolv_mount() -> Value {
        json!({
            "type": "bind",
            "source": "/repo/torrent/resolv.conf",
            "target": "/etc/resolv.conf",
            "read_only": true
        })
    }

    fn script_mount() -> Value {
        json!({
            "type": "bind",
            "source": "/repo/torrent/scripts/vpn-check.sh",
            "target": "/scripts/vpn-check.sh",
            "read_only": true
        })
    }

    fn safe_config() -> Value {
        json!({
            "services": {
                "gluetun": {
                    "environment": {
                        "VPN_SERVICE_PROVIDER": "mullvad",
                        "VPN_TYPE": "wireguard",
                        FIREWALL_ENABLED: "on",
                        "FIREWALL_OUTBOUND_SUBNETS": "192.168.1.10/32",
                        "DNS_SERVER": "on",
                        "DNS_ADDRESS": "127.0.0.1",
                        "DNS_KEEP_NAMESERVER": "off",
                        "DNS_UPSTREAM_RESOLVER_TYPE": "dot"
                    },
                    "networks": { "default": null },
                    "sysctls": { "net.ipv6.conf.all.disable_ipv6": 1 }
                },
                "vpn-check": {
                    "network_mode": "service:gluetun",
                    "volumes": [resolv_mount(), script_mount()]
                },
                "qbittorrent": {
                    "network_mode": "service:gluetun",
                    "volumes": [resolv_mount()],
                    "depends_on": {
                        "vpn-check": { "condition": "service_completed_successfully" }
                    }
                },
                "prowlarr-init": {
                    "network_mode": "service:gluetun",
                    "volumes": [resolv_mount()],
                    "depends_on": {
                        "vpn-check": { "condition": "service_completed_successfully" }
                    }
                },
                "qbittorrent-init": {
                    "network_mode": "none"
                }
            }
        })
    }

    #[test]
    fn accepts_the_isolated_layout() {
        assert_eq!(verify_torrent_isolation(&safe_config()), Ok(()));
    }

    #[test]
    fn rejects_a_service_on_a_separate_network() {
        let mut config = safe_config();
        config["services"]["qbittorrent"]["network_mode"] = json!("bridge");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("qbittorrent")));
    }

    #[test]
    fn rejects_a_sidecar_without_gluetun_resolv_conf() {
        let mut config = safe_config();
        config["services"]["qbittorrent"]
            .as_object_mut()
            .unwrap()
            .remove("volumes");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("resolv.conf")));
    }

    #[test]
    fn rejects_docker_dns_option_with_shared_network_mode() {
        let mut config = safe_config();
        config["services"]["qbittorrent"]["dns"] = json!(["127.0.0.1"]);
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("cannot set dns")));
    }

    #[test]
    fn rejects_internet_wide_firewall_exceptions() {
        for exception in ["0.0.0.0/0", "192.168.1.0/24", "1.1.1.1", "1.1.1.1/32"] {
            let mut config = safe_config();
            config["services"]["gluetun"]["environment"]["FIREWALL_OUTBOUND_SUBNETS"] =
                json!(exception);
            let problems = verify_torrent_isolation(&config).unwrap_err();
            assert!(
                problems
                    .iter()
                    .any(|p| p.contains("FIREWALL_OUTBOUND_SUBNETS")),
                "{exception} was not rejected: {problems:?}"
            );
        }
    }

    #[test]
    fn rejects_disabled_firewall_or_dns_leaks() {
        let mut config = safe_config();
        config["services"]["gluetun"]["environment"][FIREWALL_ENABLED] = json!("off");
        config["services"]["gluetun"]["environment"]["DNS_KEEP_NAMESERVER"] = json!("on");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("FIREWALL")));
        assert!(problems.iter().any(|p| p.contains("DNS_KEEP_NAMESERVER")));
    }

    #[test]
    fn recognizes_local_ipv4_ranges() {
        for address in [
            "127.0.0.1",
            "10.2.3.4",
            "172.20.1.2",
            "192.168.1.10",
            "169.254.1.1",
            "100.100.1.1",
        ] {
            assert!(is_local_ipv4(address), "{address} should be local");
        }
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "172.15.1.1",
            "100.128.0.1",
            "not-an-ip",
        ] {
            assert!(!is_local_ipv4(address), "{address} should not be local");
        }
    }

    #[test]
    fn committed_resolv_conf_uses_gluetun_only() {
        let nameservers: Vec<&str> = include_str!("../torrent/resolv.conf")
            .lines()
            .filter_map(|line| line.trim().strip_prefix("nameserver "))
            .collect();
        assert_eq!(nameservers, ["127.0.0.1"]);
    }

    #[test]
    fn rejects_a_missing_vpn_check_gate() {
        let mut config = safe_config();
        config["services"]
            .as_object_mut()
            .unwrap()
            .remove("vpn-check");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-check")));
    }

    #[test]
    fn rejects_enabled_ipv6() {
        let mut config = safe_config();
        config["services"]["gluetun"]["sysctls"] = json!({ "net.ipv6.conf.all.disable_ipv6": 0 });
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("IPv6")));
    }
}
