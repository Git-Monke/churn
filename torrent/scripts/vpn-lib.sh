#!/bin/sh
# Shared VPN boundary checks.
#
# Sourced by `vpn-check.sh` (the fail-closed startup gate) and
# `vpn-status.sh` (the on-demand dashboard check). Keeping the logic here means
# the startup proof and the live dashboard proof cannot drift apart.
#
# Every check returns 0 for pass and 1 for fail. Callers decide whether to log,
# retry or fail closed.

# True for IPv4 addresses that cannot be a public internet destination:
# loopback, RFC1918 private ranges, link-local and CGNAT.
vpn_is_local_ipv4() {
    case "${1:-}" in
        10.* | 127.* | 192.168.* | 169.254.*) return 0 ;;
        172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) return 0 ;;
        100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    esac
    return 1
}

# The only non-VPN firewall exception is HOST_IP. It must be empty
# (loopback-only) or a local address.
vpn_firewall_exception_ok() {
    [ -z "${1:-}" ] || vpn_is_local_ipv4 "$1"
}

# DNS must use Gluetun's local resolver and nothing else. A second upstream
# could be used during a transient DNS failure and leak queries.
vpn_dns_ok() {
    [ -s /etc/resolv.conf ] || return 1
    grep -Eq '^nameserver[[:space:]]+127\.0\.0\.1([[:space:]]|$)' /etc/resolv.conf || return 1
    if grep -E '^nameserver[[:space:]]+' /etc/resolv.conf | grep -qv '127\.0\.0\.1'; then
        return 1
    fi
    return 0
}

# Print the configured nameservers as a JSON array body (without brackets).
vpn_nameservers_json() {
    awk '
        $1 == "nameserver" {
            gsub(/[^A-Za-z0-9:._-]/, "", $2)
            if ($2 != "") {
                printf "%s\"%s\"", sep, $2
                sep = ","
            }
        }
    ' /etc/resolv.conf 2>/dev/null
}

# Extract a JSON string value without jq (the curl image ships no JSON tool).
# Only used on the two small documents fetched below.
vpn_json_value() {
    printf '%s' "${1:-}" |
        sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
        head -n 1
}

# What Gluetun believes its own tunnel address is. This is provider-neutral:
# every provider's tunnel is reflected by the same control endpoint, so no
# provider needs a bespoke exit checker. Sets VPN_GLUETUN_EXIT_IP.
vpn_fetch_gluetun_exit() {
    body=$(curl -4 -fsS \
        --connect-timeout "${VPN_GLUETUN_CONNECT_TIMEOUT:-2}" \
        --max-time "${VPN_GLUETUN_MAX_TIME:-4}" \
        "${VPN_GLUETUN_CONTROL_URL:-http://127.0.0.1:8000}/v1/publicip/ip" 2>/dev/null) || {
        VPN_GLUETUN_EXIT_IP=
        return 1
    }
    VPN_GLUETUN_EXIT_IP=$(vpn_json_value "$body" public_ip)
    [ -n "$VPN_GLUETUN_EXIT_IP" ]
}

# What the internet sees when the request leaves this namespace. Sent through
# the tunnel, so a kill switch that silently falls back to eth0 shows up here as
# a mismatch instead of looking like a healthy VPN. Sets VPN_OBSERVED_BODY and
# VPN_OBSERVED_IP.
vpn_fetch_observed_exit() {
    VPN_OBSERVED_BODY=$(curl -4 -fsS \
        --connect-timeout "${VPN_CHECK_CONNECT_TIMEOUT:-5}" \
        --max-time "${VPN_CHECK_MAX_TIME:-15}" \
        "${VPN_CHECK_URL:-https://ipinfo.io/json}" 2>/dev/null) || {
        VPN_OBSERVED_BODY=
        VPN_OBSERVED_IP=
        return 1
    }
    VPN_OBSERVED_IP=$(vpn_json_value "$VPN_OBSERVED_BODY" ip)
    [ -n "$VPN_OBSERVED_IP" ]
}

# The proof that egress is the tunnel, for any provider: the address Gluetun
# says it connected with must equal the address the outside world reports.
# Both sides must be a public IPv4 address, so a private or loopback value on
# either side cannot satisfy the match.
vpn_exit_matches_gluetun() {
    [ -n "${VPN_GLUETUN_EXIT_IP:-}" ] || return 1
    [ -n "${VPN_OBSERVED_IP:-}" ] || return 1
    vpn_is_local_ipv4 "$VPN_GLUETUN_EXIT_IP" && return 1
    vpn_is_local_ipv4 "$VPN_OBSERVED_IP" && return 1
    [ "$VPN_GLUETUN_EXIT_IP" = "$VPN_OBSERVED_IP" ]
}

# Prove the kill switch: bind the request to the non-VPN Docker interface. If
# this succeeds, the app containers could bypass the tunnel too.
vpn_direct_egress_blocked() {
    [ -e /sys/class/net/eth0 ] || return 1
    if curl -4 -fsS --interface eth0 \
        --connect-timeout "${VPN_CHECK_DIRECT_CONNECT_TIMEOUT:-5}" \
        --max-time "${VPN_CHECK_DIRECT_MAX_TIME:-8}" \
        "${VPN_CHECK_DIRECT_URL:-http://1.1.1.1/}" >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

# IPv6 is disabled in the shared namespace: the imported tunnel config is
# IPv4-only, so an enabled IPv6 stack would offer a route around it.
vpn_ipv6_disabled() {
    [ "$(cat /proc/sys/net/ipv6/conf/all/disable_ipv6 2>/dev/null)" = "1" ]
}

# Any HTTP response means the service is reachable in this namespace; 401/404
# still prove the TCP path exists.
vpn_service_reachable() {
    curl -sS -o /dev/null \
        --connect-timeout "${VPN_STATUS_COVERAGE_CONNECT_TIMEOUT:-1}" \
        --max-time "${VPN_STATUS_COVERAGE_MAX_TIME:-2}" \
        "${1:-}" >/dev/null 2>&1
}

# Seconds since boot, with sub-second precision. Kept as a decimal so the
# duration subtraction does not overflow a large uptime when scaled to ms.
vpn_now_seconds() {
    awk '{ printf "%.3f", $1 }' /proc/uptime
}

vpn_duration_ms() {
    awk -v start="$1" -v end="$2" 'BEGIN {
        duration = (end - start) * 1000
        if (duration < 0) duration = 0
        printf "%d", duration
    }'
}

# Strip anything that could break a JSON string. Used for IP/address fields
# that are embedded directly by the status agent, where a narrow charset is
# exactly right.
vpn_json_token() {
    printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9:._/-'
}

# Like vpn_json_token, but keeps spaces and punctuation so a provider's country
# and organisation names stay readable. Removes only what would end the string
# or start an escape.
vpn_json_text() {
    printf '%s' "${1:-}" | tr -d '"' | tr -d '\134' | tr -d '\000-\037\177'
}
