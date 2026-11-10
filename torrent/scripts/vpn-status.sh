#!/bin/sh
# Live VPN leak check for the dashboard.
#
# Runs with `network_mode: "service:gluetun"`, the same namespace qBittorrent,
# Prowlarr and FlareSolverr use. Two modes:
#
#   vpn-status.sh serve   entrypoint: serve one HTTP response per connection
#   vpn-status.sh         handler: run the checks now and write the response
#
# The port is published on the host loopback only, and the churn backend is the
# only client. The checks are shared with the fail-closed startup gate
# (vpn-check.sh) through vpn-lib.sh.
set -eu

# shellcheck source=vpn-lib.sh
. "${VPN_LIB_PATH:-/scripts/vpn-lib.sh}"

if [ "${1:-}" = "serve" ]; then
    port=${VPN_STATUS_PORT:-8098}
    # `-l -l` keeps accepting connections and `-e` executes this script with
    # the socket on stdin/stdout. The curl image's BusyBox has nc but not httpd.
    exec busybox nc -l -l -p "$port" -e /scripts/vpn-status.sh
fi

# Drain the request headers so closing the socket does not reset the response.
while IFS= read -r line; do
    case "$line" in
        *"$(printf '\r')") line=${line%?} ;;
    esac
    [ -z "$line" ] && break
done

# Keep the whole request comfortably below the backend timeout, even when the
# VPN is reconnecting and the exit lookup has to retry.
VPN_CHECK_CONNECT_TIMEOUT=${VPN_CHECK_CONNECT_TIMEOUT:-3}
VPN_CHECK_MAX_TIME=${VPN_CHECK_MAX_TIME:-6}
VPN_CHECK_DIRECT_CONNECT_TIMEOUT=${VPN_CHECK_DIRECT_CONNECT_TIMEOUT:-2}
VPN_CHECK_DIRECT_MAX_TIME=${VPN_CHECK_DIRECT_MAX_TIME:-4}
VPN_STATUS_COVERAGE_CONNECT_TIMEOUT=${VPN_STATUS_COVERAGE_CONNECT_TIMEOUT:-1}
VPN_STATUS_COVERAGE_MAX_TIME=${VPN_STATUS_COVERAGE_MAX_TIME:-2}

started_seconds=$(vpn_now_seconds)

host_ip=${HOST_IP:-}
firewall_exception=0
if vpn_firewall_exception_ok "$host_ip"; then
    firewall_exception=1
fi

dns=0
if vpn_dns_ok; then
    dns=1
fi

attempts=${VPN_STATUS_ATTEMPTS:-2}
delay=${VPN_STATUS_RETRY_DELAY_SECONDS:-1}
attempt=1
while :; do
    if vpn_fetch_observed_exit; then
        break
    fi
    if [ "$attempt" -ge "$attempts" ]; then
        break
    fi
    attempt=$((attempt + 1))
    sleep "$delay"
done

vpn_fetch_gluetun_exit || true
tunnel_exit=0
if vpn_exit_matches_gluetun; then
    tunnel_exit=1
fi

kill_switch=0
if [ -e /sys/class/net/eth0 ] && vpn_direct_egress_blocked; then
    kill_switch=1
fi

ipv6=0
if vpn_ipv6_disabled; then
    ipv6=1
fi

qbittorrent=0
if vpn_service_reachable "${QBITTORRENT_URL:-http://127.0.0.1:8080}"; then
    qbittorrent=1
fi
prowlarr=0
if vpn_service_reachable "${PROWLARR_URL:-http://127.0.0.1:9696}"; then
    prowlarr=1
fi
flaresolverr=0
if vpn_service_reachable "${FLARESOLVERR_URL:-http://127.0.0.1:8191}"; then
    flaresolverr=1
fi

secure=false
if [ "$tunnel_exit" = 1 ] &&
    [ "$kill_switch" = 1 ] &&
    [ "$dns" = 1 ] &&
    [ "$ipv6" = 1 ] &&
    [ "$firewall_exception" = 1 ]; then
    secure=true
fi

json_bool() {
    if [ "$1" = 1 ]; then
        printf 'true'
    else
        printf 'false'
    fi
}

# Only embed the exit body if it looks like a JSON object. The endpoint returns
# JSON; a captive portal or proxy error page must not break the whole response.
observed_json=${VPN_OBSERVED_BODY:-}
case "$observed_json" in
    \{*\}) ;;
    *) observed_json='{}' ;;
esac

if [ "$firewall_exception" = 1 ]; then
    firewall_exception_value=$(vpn_json_token "$host_ip")
else
    firewall_exception_value=
fi
nameservers=$(vpn_nameservers_json)
finished_seconds=$(vpn_now_seconds)
duration_ms=$(vpn_duration_ms "$started_seconds" "$finished_seconds")

printf 'HTTP/1.1 200 OK\r\n'
printf 'Content-Type: application/json\r\n'
printf 'Cache-Control: no-store\r\n'
printf 'X-Content-Type-Options: nosniff\r\n'
printf 'Connection: close\r\n'
printf '\r\n'
cat <<EOF
{
  "checkedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "durationMs": $duration_ms,
  "secure": $secure,
  "provider": "$(vpn_json_token "${VPN_SERVICE_PROVIDER:-unknown}")",
  "protocol": "$(vpn_json_token "${VPN_TYPE:-unknown}")",
  "checks": {
    "tunnelExit": $(json_bool "$tunnel_exit"),
    "killSwitch": $(json_bool "$kill_switch"),
    "dns": $(json_bool "$dns"),
    "ipv6": $(json_bool "$ipv6"),
    "firewallException": $(json_bool "$firewall_exception")
  },
  "exit": {
    "ip": "$(vpn_json_token "${VPN_OBSERVED_IP:-}")",
    "gluetunIp": "$(vpn_json_token "${VPN_GLUETUN_EXIT_IP:-}")",
    "matchesGluetun": $(json_bool "$tunnel_exit"),
    "country": "$(vpn_json_text "$(vpn_json_value "$observed_json" country)")",
    "organization": "$(vpn_json_text "$(vpn_json_value "$observed_json" org)")"
  },
  "observed": $observed_json,
  "dns": { "nameservers": [${nameservers}] },
  "firewall": {
    "directEgressBlocked": $(json_bool "$kill_switch"),
    "exception": "$firewall_exception_value"
  },
  "ipv6": { "disabled": $(json_bool "$ipv6") },
  "coverage": [
    { "id": "qbittorrent", "reachable": $(json_bool "$qbittorrent") },
    { "id": "prowlarr", "reachable": $(json_bool "$prowlarr") },
    { "id": "flaresolverr", "reachable": $(json_bool "$flaresolverr") }
  ]
}
EOF
