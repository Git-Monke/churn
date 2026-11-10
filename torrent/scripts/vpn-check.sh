#!/bin/sh
# Fail-closed VPN egress check.
#
# Runs inside Gluetun's network namespace before the torrent clients start.
# It refuses to let qBittorrent, Prowlarr, FlareSolverr or prowlarr-init start
# unless all of these are true:
#
#   * /etc/resolv.conf uses Gluetun's local DNS resolver only (no host/Docker
#     nameserver fallback that could leak DNS outside the tunnel),
#   * the exit address Gluetun believes it connected with is the address the
#     internet reports from inside this namespace, and
#   * the physical Docker interface (eth0) cannot reach the internet directly.
#
# The exit-IP comparison works for every provider Gluetun supports, so no
# provider gets a bespoke check here.
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
provider=${VPN_SERVICE_PROVIDER:-unknown}
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
log "provider is $provider (${VPN_TYPE:-unknown})"

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
    if vpn_fetch_observed_exit; then
        break
    fi
    if [ "$attempt" -eq "$attempts" ]; then
        fail "could not reach ${VPN_CHECK_URL:-https://ipinfo.io/json} after $attempts attempts (is the VPN connected?)"
    fi
    log "waiting for $provider egress ($attempt/$attempts)"
    attempt=$((attempt + 1))
    sleep "$delay"
done

if ! vpn_fetch_gluetun_exit; then
    fail "Gluetun does not report a tunnel exit IP (is the tunnel up?)"
fi
if ! vpn_exit_matches_gluetun; then
    printf 'gluetun exit: %s\nobserved exit: %s\n' \
        "${VPN_GLUETUN_EXIT_IP:-none}" "${VPN_OBSERVED_IP:-none}" >&2
    printf '%s\n' "${VPN_OBSERVED_BODY:-}" >&2
    fail "public egress does not match the tunnel exit"
fi
log "egress is the $provider tunnel exit ($VPN_OBSERVED_IP)"

if [ ! -e /sys/class/net/eth0 ]; then
    fail "non-VPN interface eth0 is missing; refusing to assume it is blocked"
fi
if ! vpn_direct_egress_blocked; then
    fail "traffic through eth0 reached the internet; the VPN kill switch is not effective"
fi
log "direct eth0 egress is blocked"

log "PASS: torrent egress is confined to the VPN"
