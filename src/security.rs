//! Safety checks for the torrent stack's VPN boundary.
//!
//! The compose file is static, but environment values can change what Docker
//! actually creates. `docker compose config --format json` gives the effective
//! configuration; these checks reject any service that could get a network path
//! around Gluetun's kill switch.

use serde_json::{Map, Value};

use crate::vpn::VpnProvider;

const GLUETUN: &str = "gluetun";
const GLUETUN_NETNS: &str = "service:gluetun";
const FILTERED_NETWORK: &str = "none";
const GLUETUN_DNS: &str = "127.0.0.1";
const LOOPBACK_HOST: &str = "127.0.0.1";
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
    let status_port = services
        .get("vpn-status")
        .and_then(|service| service.get("environment"))
        .and_then(Value::as_object)
        .and_then(|env| env_str(env, "VPN_STATUS_PORT"))
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(8098);
    check_gluetun(gluetun, &mut problems);
    check_status_port(gluetun, status_port, &mut problems);
    check_vpn_gate(services, &mut problems);
    check_vpn_status(services, &mut problems);

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
        problems.push("gluetun must use its own network namespace, not network_mode".to_string());
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

    check_vpn_provider(&env, problems);

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

/// The tunnel itself: a known provider, the protocol it supports, the
/// credentials that protocol reads, and a location the provider actually has.
///
/// This is what replaces the old `mullvad` + `wireguard` literal check. Every
/// provider is held to the same rule, so a PIA install is not "wrong" for
/// lacking a WireGuard key and a Mullvad install with `VPN_TYPE=openvpn` is.
fn check_vpn_provider(env: &Map<String, Value>, problems: &mut Vec<String>) {
    let accepted = VpnProvider::ALL
        .iter()
        .map(|provider| provider.gluetun_id())
        .collect::<Vec<_>>()
        .join(", ");

    let Some(id) = env_str(env, "VPN_SERVICE_PROVIDER").filter(|id| !id.trim().is_empty()) else {
        problems.push(format!(
            "gluetun must set VPN_SERVICE_PROVIDER to one of: {accepted}"
        ));
        return;
    };
    let Some(provider) = VpnProvider::from_gluetun_id(id) else {
        problems.push(format!(
            "gluetun VPN_SERVICE_PROVIDER {id:?} is not supported; use one of: {accepted}"
        ));
        return;
    };

    let expected = provider.protocol().as_env();
    match env_str(env, "VPN_TYPE") {
        Some(actual) if actual == expected => {}
        Some(actual) => problems.push(format!(
            "{} only supports VPN_TYPE={expected}, found {actual:?}",
            provider.label()
        )),
        None => problems.push(format!(
            "gluetun must set VPN_TYPE={expected} for {}",
            provider.label()
        )),
    }

    for key in provider.required_env() {
        if env_str(env, key).map(str::trim).is_none_or(str::is_empty) {
            problems.push(format!(
                "{} over {} requires a non-empty {key}",
                provider.label(),
                provider.protocol().label()
            ));
        }
    }

    check_vpn_location(provider, env, problems);
}

/// A location key must be the one this provider reads, and every entry in it
/// must be a location the provider actually has.
///
/// The stale-key half matters after a provider switch: Gluetun ignores a filter
/// key it does not read, so a leftover `SERVER_REGIONS` would silently widen the
/// PIA install to the whole world instead of the chosen region.
fn check_vpn_location(provider: VpnProvider, env: &Map<String, Value>, problems: &mut Vec<String>) {
    for key in ["SERVER_COUNTRIES", "SERVER_REGIONS"] {
        let Some(value) = env_str(env, key).map(str::trim).filter(|v| !v.is_empty()) else {
            continue;
        };
        if key != provider.location_key() {
            problems.push(format!(
                "{} reads its location from {}, so {key} must be empty (found {value:?})",
                provider.label(),
                provider.location_key()
            ));
            continue;
        }
        for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            if let Err(message) = provider.validate_location(entry) {
                problems.push(format!("{key}: {message}"));
            }
        }
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
    if !has_read_only_mount(
        vpn_check,
        "/scripts/vpn-lib.sh",
        "/torrent/scripts/vpn-lib.sh",
    ) {
        problems.push("vpn-check must mount its shared check library read-only".to_string());
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

/// The dashboard check agent must share Gluetun's namespace and must not be
/// reachable without the script mounts it needs.
fn check_vpn_status(services: &Map<String, Value>, problems: &mut Vec<String>) {
    let Some(vpn_status) = services.get("vpn-status") else {
        problems.push("the torrent stack has no vpn-status dashboard agent".to_string());
        return;
    };
    if vpn_status.get("network_mode").and_then(Value::as_str) != Some(GLUETUN_NETNS) {
        problems.push("vpn-status must share Gluetun's network namespace".to_string());
    }
    if !has_read_only_mount(
        vpn_status,
        "/scripts/vpn-status.sh",
        "/torrent/scripts/vpn-status.sh",
    ) {
        problems.push("vpn-status must mount its server script read-only".to_string());
    }
    if !has_read_only_mount(
        vpn_status,
        "/scripts/vpn-lib.sh",
        "/torrent/scripts/vpn-lib.sh",
    ) {
        problems.push("vpn-status must mount the shared check library read-only".to_string());
    }
}

/// The status agent returns security details. If Gluetun publishes it, the host
/// side must be loopback so it is not exposed to the LAN.
fn check_status_port(gluetun: &Value, status_port: i64, problems: &mut Vec<String>) {
    let Some(ports) = gluetun.get("ports").and_then(Value::as_array) else {
        return;
    };
    for port in ports {
        if port.get("target").and_then(Value::as_i64) != Some(status_port) {
            continue;
        }
        if port.get("host_ip").and_then(Value::as_str) != Some(LOOPBACK_HOST) {
            problems
                .push("the vpn-status port must bind 127.0.0.1, not a LAN interface".to_string());
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

    fn lib_mount() -> Value {
        json!({
            "type": "bind",
            "source": "/repo/torrent/scripts/vpn-lib.sh",
            "target": "/scripts/vpn-lib.sh",
            "read_only": true
        })
    }

    fn status_script_mount(target: &str) -> Value {
        json!({
            "type": "bind",
            "source": "/repo/torrent/scripts/vpn-status.sh",
            "target": target,
            "read_only": true
        })
    }

    fn status_port() -> Value {
        json!({
            "mode": "ingress",
            "target": 8098,
            "published": "8098",
            "protocol": "tcp",
            "host_ip": "127.0.0.1"
        })
    }

    /// The environment Gluetun needs for `provider`, filled with fake values.
    /// Both location keys exist in the real compose file, so this mirrors that:
    /// the one the provider does not read is empty.
    fn provider_env(provider: VpnProvider) -> Value {
        let mut env = Map::new();
        env.insert("VPN_SERVICE_PROVIDER".into(), json!(provider.gluetun_id()));
        env.insert("VPN_TYPE".into(), json!(provider.protocol().as_env()));
        for key in provider.required_env() {
            env.insert((*key).into(), json!(format!("{key}-value")));
        }
        for key in ["SERVER_COUNTRIES", "SERVER_REGIONS"] {
            let location = if key == provider.location_key() {
                provider.default_location().unwrap_or_default()
            } else {
                ""
            };
            env.insert(key.into(), json!(location));
        }
        Value::Object(env)
    }

    /// The credential/firewall environment for `provider` on an otherwise
    /// valid layout.
    fn safe_config(provider: VpnProvider) -> Value {
        safe_config_with(provider, &[])
    }

    /// `safe_config`, with extra `(key, value)` pairs merged into Gluetun's
    /// environment after the provider's own.
    fn safe_config_with(provider: VpnProvider, extra: &[(&str, Value)]) -> Value {
        let mut config = base_config();
        let env = config["services"]["gluetun"]["environment"]
            .as_object_mut()
            .expect("environment is an object");
        for (key, value) in provider_env(provider).as_object().expect("provider env") {
            env.insert(key.clone(), value.clone());
        }
        for (key, value) in extra {
            env.insert((*key).into(), value.clone());
        }
        config
    }

    fn base_config() -> Value {
        json!({
            "services": {
                "gluetun": {
                    "environment": {
                        FIREWALL_ENABLED: "on",
                        "FIREWALL_OUTBOUND_SUBNETS": "192.168.1.10/32",
                        "DNS_SERVER": "on",
                        "DNS_ADDRESS": "127.0.0.1",
                        "DNS_KEEP_NAMESERVER": "off",
                        "DNS_UPSTREAM_RESOLVER_TYPE": "dot"
                    },
                    "networks": { "default": null },
                    "ports": [status_port()],
                    "sysctls": { "net.ipv6.conf.all.disable_ipv6": 1 }
                },
                "vpn-check": {
                    "network_mode": "service:gluetun",
                    "volumes": [resolv_mount(), script_mount(), lib_mount()]
                },
                "vpn-status": {
                    "network_mode": "service:gluetun",
                    "volumes": [
                        resolv_mount(),
                        lib_mount(),
                        status_script_mount("/scripts/vpn-status.sh")
                    ],
                    "depends_on": {
                        "vpn-check": { "condition": "service_completed_successfully" }
                    }
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
        assert_eq!(
            verify_torrent_isolation(&safe_config(VpnProvider::Mullvad)),
            Ok(())
        );
    }

    #[test]
    fn accepts_every_provider() {
        for provider in VpnProvider::ALL {
            assert_eq!(
                verify_torrent_isolation(&safe_config(provider)),
                Ok(()),
                "{} was rejected",
                provider.label()
            );
        }
    }

    #[test]
    fn rejects_an_unknown_provider() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]["VPN_SERVICE_PROVIDER"] = json!("foo");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems
                .iter()
                .any(|p| p.contains("not supported") && p.contains("mullvad")),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_a_missing_provider() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]
            .as_object_mut()
            .unwrap()
            .remove("VPN_SERVICE_PROVIDER");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("VPN_SERVICE_PROVIDER")),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_a_protocol_the_provider_does_not_support() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]["VPN_TYPE"] = json!("openvpn");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems
                .iter()
                .any(|p| p.contains("VPN_TYPE=wireguard") && p.contains("Mullvad")),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_a_missing_or_blank_credential() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]["WIREGUARD_PRIVATE_KEY"] = json!("");
        config["services"]["gluetun"]["environment"]
            .as_object_mut()
            .unwrap()
            .remove("WIREGUARD_ADDRESSES");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("WIREGUARD_PRIVATE_KEY")),
            "blank key not rejected: {problems:?}"
        );
        assert!(
            problems.iter().any(|p| p.contains("WIREGUARD_ADDRESSES")),
            "missing address not rejected: {problems:?}"
        );
    }

    #[test]
    fn accepts_a_password_but_rejects_a_blank_one() {
        let mut config = safe_config(VpnProvider::PrivateInternetAccess);
        assert_eq!(verify_torrent_isolation(&config), Ok(()));
        config["services"]["gluetun"]["environment"]["OPENVPN_PASSWORD"] = json!("  ");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems.iter().any(|p| p.contains("OPENVPN_PASSWORD")),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_the_other_providers_location_key() {
        let mut config = safe_config(VpnProvider::PrivateInternetAccess);
        config["services"]["gluetun"]["environment"]["SERVER_COUNTRIES"] = json!("Netherlands");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(
            problems
                .iter()
                .any(|p| p.contains("SERVER_REGIONS") && p.contains("SERVER_COUNTRIES")),
            "{problems:?}"
        );
    }

    #[test]
    fn rejects_a_location_the_provider_does_not_have() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]["SERVER_COUNTRIES"] =
            json!("Netherlands, Mars");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("Mars")), "{problems:?}");
    }

    #[test]
    fn accepts_several_comma_separated_locations() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["environment"]["SERVER_COUNTRIES"] =
            json!("Netherlands,Germany");
        assert_eq!(verify_torrent_isolation(&config), Ok(()));
    }

    #[test]
    fn rejects_a_service_on_a_separate_network() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["qbittorrent"]["network_mode"] = json!("bridge");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("qbittorrent")));
    }

    #[test]
    fn rejects_a_sidecar_without_gluetun_resolv_conf() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["qbittorrent"]
            .as_object_mut()
            .unwrap()
            .remove("volumes");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("resolv.conf")));
    }

    #[test]
    fn rejects_docker_dns_option_with_shared_network_mode() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["qbittorrent"]["dns"] = json!(["127.0.0.1"]);
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("cannot set dns")));
    }

    #[test]
    fn rejects_internet_wide_firewall_exceptions() {
        for exception in ["0.0.0.0/0", "192.168.1.0/24", "1.1.1.1", "1.1.1.1/32"] {
            let mut config = safe_config(VpnProvider::Mullvad);
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
        let mut config = safe_config(VpnProvider::Mullvad);
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
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]
            .as_object_mut()
            .unwrap()
            .remove("vpn-check");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-check")));
    }

    #[test]
    fn rejects_a_missing_vpn_status_agent() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]
            .as_object_mut()
            .unwrap()
            .remove("vpn-status");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-status")));
    }

    #[test]
    fn rejects_a_vpn_status_agent_on_a_separate_network() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["vpn-status"]["network_mode"] = json!("bridge");
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-status")));
    }

    #[test]
    fn rejects_a_vpn_status_port_exposed_on_the_lan() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["ports"] = json!([
            {
                "mode": "ingress",
                "target": 8098,
                "published": "8098",
                "protocol": "tcp",
                "host_ip": "0.0.0.0"
            }
        ]);
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-status port")));
    }

    #[test]
    fn rejects_a_moved_status_port_published_on_the_host() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["vpn-status"]["environment"] = serde_json::json!({
            "VPN_STATUS_PORT": "18098"
        });
        config["services"]["gluetun"]["ports"] = serde_json::json!([{
            "target": 18098,
            "published": "18098",
            "protocol": "tcp",
            "host_ip": "0.0.0.0"
        }]);
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("vpn-status port")));
    }

    #[test]
    fn accepts_a_moved_status_port_bound_to_loopback() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["vpn-status"]["environment"] = serde_json::json!({
            "VPN_STATUS_PORT": "18098"
        });
        config["services"]["gluetun"]["ports"] = serde_json::json!([{
            "target": 18098,
            "published": "18098",
            "protocol": "tcp",
            "host_ip": "127.0.0.1"
        }]);
        assert_eq!(verify_torrent_isolation(&config), Ok(()));
    }

    #[test]
    fn rejects_enabled_ipv6() {
        let mut config = safe_config(VpnProvider::Mullvad);
        config["services"]["gluetun"]["sysctls"] = json!({ "net.ipv6.conf.all.disable_ipv6": 0 });
        let problems = verify_torrent_isolation(&config).unwrap_err();
        assert!(problems.iter().any(|p| p.contains("IPv6")));
    }
}
