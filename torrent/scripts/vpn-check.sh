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
set -eu

check_url=${VPN_CHECK_URL:-https://am.i.mullvad.net/json}
direct_url=${VPN_CHECK_DIRECT_URL:-http://1.1.1.1/}
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
    case "$host_ip" in
        10.* | 127.* | 192.168.* | 169.254.*) ;;
        172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].*) ;;
        100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) ;;
        *) fail "HOST_IP=$host_ip is not a loopback/LAN address" ;;
    esac
    log "firewall exception is local HOST_IP=$host_ip"
else
    log "HOST_IP is unset; firewall exception is loopback only"
fi

# Gluetun's DNS server listens on 127.0.0.1 in the shared namespace. Every
# resolver listed here must be that server; a second upstream could be used
# during a transient DNS failure.
if [ ! -s /etc/resolv.conf ]; then
    fail "/etc/resolv.conf is missing"
fi
if ! grep -Eq '^nameserver[[:space:]]+127\.0\.0\.1([[:space:]]|$)' /etc/resolv.conf; then
    cat /etc/resolv.conf >&2
    fail "not using Gluetun's DNS resolver at 127.0.0.1"
fi
if grep -E '^nameserver[[:space:]]+' /etc/resolv.conf | grep -qv '127\.0\.0\.1'; then
    cat /etc/resolv.conf >&2
    fail "resolv.conf contains a non-Gluetun nameserver"
fi
log "DNS uses Gluetun's local resolver"

attempt=1
body=
while [ "$attempt" -le "$attempts" ]; do
    if body=$(curl -4 -fsS --connect-timeout 5 --max-time 15 "$check_url" 2>/dev/null); then
        break
    fi
    body=
    if [ "$attempt" -eq "$attempts" ]; then
        fail "could not reach $check_url after $attempts attempts (is the VPN connected?)"
    fi
    log "waiting for Mullvad egress ($attempt/$attempts)"
    attempt=$((attempt + 1))
    sleep "$delay"
done

if ! printf '%s\n' "$body" | grep -Eq '"mullvad_exit_ip"[[:space:]]*:[[:space:]]*true'; then
    printf '%s\n' "$body" >&2
    fail "public egress is not a Mullvad exit"
fi
log "egress is a Mullvad exit"

# Prove the kill switch: bind the request to the non-VPN Docker interface. If
# this succeeds, the app containers could bypass the tunnel too.
if [ ! -e /sys/class/net/eth0 ]; then
    fail "non-VPN interface eth0 is missing; refusing to assume it is blocked"
fi
if curl -4 -fsS --interface eth0 --connect-timeout 5 --max-time 8 \
    "$direct_url" >/dev/null 2>&1; then
    fail "traffic through eth0 reached the internet; the VPN kill switch is not effective"
fi
log "direct eth0 egress is blocked"

log "PASS: torrent egress is confined to the VPN"
