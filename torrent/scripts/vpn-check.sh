#!/bin/sh
# Fail-closed VPN egress check.
#
# Runs inside Gluetun's network namespace before the torrent clients start.
# It refuses to let qBittorrent, Prowlarr, FlareSolverr or prowlarr-init start
# unless all of these are true:
#
#   * /etc/resolv.conf uses Gluetun's local DNS resolver only (no host/Docker
#     nameserver fallback that could leak DNS outside the tunnel),
#   * a request to Mullvad's exit checker reports a Mullvad exit IP, and
#   * the physical Docker interface (eth0) cannot reach the internet directly.
#
# The firewall in Gluetun is the actual kill switch. This check catches a
# broken firewall, a wrong VPN provider/config or a broad
# FIREWALL_OUTBOUND_SUBNETS before any download or indexer traffic begins.
#
# The individual checks live in vpn-lib.sh so the live dashboard check
# (vpn-status.sh) runs exactly the same logic.
set -eu

# shellcheck source=vpn-lib.sh
. "${VPN_LIB_PATH:-/scripts/vpn-lib.sh}"

host_ip=${HOST_IP:-}
attempts=${VPN_CHECK_ATTEMPTS:-20}
delay=${VPN_CHECK_DELAY_SECONDS:-2}

log() {
    printf 'vpn-check: %s\n' "$*" >&2
}

fail() {
    log "FAILED: $*"
    exit 1
}

# This is the only non-VPN destination Gluetun allows. It must be a
# loopback/LAN address, never a public one. HOST_IP is empty when churn falls
# back to 127.0.0.1.
if [ -n "$host_ip" ]; then
    vpn_is_local_ipv4 "$host_ip" ||
        fail "HOST_IP=$host_ip is not a loopback/LAN address"
    log "firewall exception is local HOST_IP=$host_ip"
else
    log "HOST_IP is unset; firewall exception is loopback only"
fi

# Gluetun's DNS server listens on 127.0.0.1 in the shared namespace. Every
# resolver listed here must be that server; a second upstream could be used
# during a transient DNS failure.
if ! vpn_dns_ok; then
    [ -s /etc/resolv.conf ] || fail "/etc/resolv.conf is missing"
    cat /etc/resolv.conf >&2
    if ! grep -Eq '^nameserver[[:space:]]+127\.0\.0\.1([[:space:]]|$)' /etc/resolv.conf; then
        fail "not using Gluetun's DNS resolver at 127.0.0.1"
    fi
    fail "resolv.conf contains a non-Gluetun nameserver"
fi
log "DNS uses Gluetun's local resolver"

attempt=1
while [ "$attempt" -le "$attempts" ]; do
    if vpn_fetch_mullvad; then
        break
    fi
    if [ "$attempt" -eq "$attempts" ]; then
        fail "could not reach ${VPN_CHECK_URL:-https://am.i.mullvad.net/json} after $attempts attempts (is the VPN connected?)"
    fi
    log "waiting for Mullvad egress ($attempt/$attempts)"
    attempt=$((attempt + 1))
    sleep "$delay"
done

if ! vpn_is_mullvad_exit; then
    printf '%s\n' "${VPN_MULLVAD_BODY:-}" >&2
    fail "public egress is not a Mullvad exit"
fi
log "egress is a Mullvad exit"

if [ ! -e /sys/class/net/eth0 ]; then
    fail "non-VPN interface eth0 is missing; refusing to assume it is blocked"
fi
if ! vpn_direct_egress_blocked; then
    fail "traffic through eth0 reached the internet; the VPN kill switch is not effective"
fi
log "direct eth0 egress is blocked"

log "PASS: torrent egress is confined to the VPN"
