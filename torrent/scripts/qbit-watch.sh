#!/bin/sh
# Restart qBittorrent when its libtorrent session falls out of sync with the VPN.
#
# Gluetun can restart its own tunnel without recreating this network namespace.
# When that happens the sidecars keep the namespace, but qBittorrent keeps the
# libtorrent session it built on the old exit: DHT goes to zero nodes, the
# status shows "firewalled", and downloads sit at 0% until qBittorrent is
# restarted. A restart is enough to fix it: the linuxserver image runs
# qbittorrent-nox under s6, so a graceful WebUI shutdown brings up a fresh
# session inside the same container (no Docker control needed).
#
# This watcher runs in Gluetun's namespace beside qBittorrent and restarts it
# when:
#
#   * Gluetun's tunnel comes back up after being down (a reconnect), or
#   * Gluetun's exit IP changes, or
#   * DHT has reported zero nodes for longer than the stall threshold, or
#   * qBittorrent's own external address has disagreed with Gluetun's exit for
#     longer than the divergence threshold (the reconnect was missed, e.g. the
#     watcher itself restarted after the fact).
#
# Every restart is clamped by a cooldown so a VPN that flaps cannot turn into a
# restart loop, and the DHT rule is suspended for a grace period afterwards so
# a session that is still bootstrapping is not restarted again.
set -eu

qbittorrent=${QBITTORRENT_URL:-http://127.0.0.1:8080}
gluetun_control=${GLUETUN_CONTROL_URL:-http://127.0.0.1:8000}
config_root=${QBITTORRENT_CONFIG_ROOT:-/qbittorrent-config}

interval=${QBIT_WATCH_INTERVAL_SECONDS:-5}
stall_seconds=${QBIT_WATCH_DHT_STALL_SECONDS:-30}
grace_seconds=${QBIT_WATCH_GRACE_SECONDS:-120}
cooldown_seconds=${QBIT_WATCH_RESTART_COOLDOWN_SECONDS:-180}
divergence_seconds=${QBIT_WATCH_IP_DIVERGENCE_SECONDS:-600}
api_timeout=${QBIT_WATCH_API_TIMEOUT_SECONDS:-5}
restart_wait=${QBIT_WATCH_RESTART_WAIT_SECONDS:-60}
# Set to 1 to log what would be restarted without touching qBittorrent. Used by
# the tests and useful when tuning thresholds on a live host.
dry_run=${QBIT_WATCH_DRY_RUN:-0}

log() {
    printf 'qbit-watch: %s\n' "$*" >&2
}

# qBittorrent 5.x stores the API key under [WebUI] as APIKey=. Older churn
# releases wrote WebUI\APIKey under [Preferences]; accept that as a fallback
# while qbittorrent-init migrates it. Same parsing as prowlarr-init.sh.
read_key() {
    awk '
        /^\[/ { in_webui = ($0 == "[WebUI]"); next }
        in_webui && /^APIKey=/ { sub(/^APIKey=/, ""); print; exit }
    ' "$config_root/qBittorrent/qBittorrent.conf" 2>/dev/null
}

read_legacy_key() {
    sed -n 's:^WebUI\\APIKey=\(.*\)$:\1:p' \
        "$config_root/qBittorrent/qBittorrent.conf" 2>/dev/null | head -n 1
}

# Fetch a URL into QBIT_WATCH_BODY. Returns non-zero on any HTTP/transport error.
fetch() {
    QBIT_WATCH_BODY=$(curl -fsS --max-time "$api_timeout" "$1" 2>/dev/null) || {
        QBIT_WATCH_BODY=
        return 1
    }
}

# Extract a JSON string value without jq (the curl image has no JSON tool).
json_string() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Extract a JSON integer value. Prints nothing when the key is absent.
json_number() {
    printf '%s' "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9][0-9]*\).*/\1/p'
}

qbittorrent_api() {
    curl -fsS --max-time "$api_timeout" \
        -H "Authorization: Bearer $api_key" "$1" 2>/dev/null
}

# The API key is seeded by qbittorrent-init before this service starts, but a
# manual `docker compose up qbit-watch` can race that one-shot. Wait instead of
# crash-looping.
load_key() {
    started=$(date +%s)
    while :; do
        api_key=$(read_key)
        if [ -z "$api_key" ]; then
            api_key=$(read_legacy_key)
        fi
        if [ -n "$api_key" ]; then
            return 0
        fi
        if [ $(($(date +%s) - started)) -ge 120 ]; then
            log "timed out waiting for qBittorrent's API key in $config_root"
            return 1
        fi
        sleep 2
    done
}

# Ask qBittorrent to shut down and wait for s6 to bring it back up. Returns
# non-zero only if the shutdown request itself failed; a slow restart is logged
# and left to the next iteration.
restart_qbittorrent() {
    if [ "$dry_run" = 1 ]; then
        log "dry run: would restart qBittorrent: $1"
        return 0
    fi
    log "restarting qBittorrent: $1"
    if ! curl -fsS --max-time "$api_timeout" -o /dev/null -X POST \
        -H "Authorization: Bearer $api_key" "$qbittorrent/api/v2/app/shutdown" \
        2>/dev/null; then
        log "shutdown request failed; is qBittorrent still running?"
        return 1
    fi

    waited=0
    while [ "$waited" -lt "$restart_wait" ]; do
        if qbittorrent_api "$qbittorrent/api/v2/app/webapiVersion" >/dev/null; then
            log "qBittorrent is back after ${waited}s"
            return 0
        fi
        sleep 2
        waited=$((waited + 2))
    done
    log "qBittorrent did not answer within ${restart_wait}s; leaving it alone"
    return 0
}

now_seconds() {
    date +%s
}

load_key || exit 1

# Baseline state. Empty means "not observed yet": the first sample is the
# baseline, never a reason to restart.
last_vpn_status=
last_exit_ip=
dht_zero_since=
divergence_since=
last_restart=0
suppressed_until=0

log "watching qBittorrent's VPN session (interval ${interval}s, DHT stall ${stall_seconds}s)"

while :; do
    now=$(now_seconds)
    reason=

    vpn_status=
    if fetch "$gluetun_control/v1/vpn/status"; then
        vpn_status=$(json_string "$QBIT_WATCH_BODY" status)
    fi

    exit_ip=
    if fetch "$gluetun_control/v1/publicip/ip"; then
        exit_ip=$(json_string "$QBIT_WATCH_BODY" public_ip)
    fi

    # A reconnect is visible as status leaving "running" and later returning,
    # or (if the watcher missed the down phase) as a new exit IP.
    if [ -n "$vpn_status" ] && [ -n "$last_vpn_status" ]; then
        if [ "$last_vpn_status" != "running" ] && [ "$vpn_status" = "running" ]; then
            reason="VPN reconnected"
        elif [ -n "$exit_ip" ] && [ -n "$last_exit_ip" ] &&
            [ "$exit_ip" != "$last_exit_ip" ] && [ "$vpn_status" = "running" ]; then
            reason="VPN exit changed to $exit_ip"
        fi
    fi
    if [ -n "$vpn_status" ]; then
        last_vpn_status=$vpn_status
    fi
    if [ -n "$exit_ip" ]; then
        last_exit_ip=$exit_ip
    fi

    # qBittorrent's own view of the outside world, used only to catch a
    # reconnect that happened while this watcher was not looking.
    transfer_info=
    if [ -z "$reason" ] && [ "$now" -ge "$suppressed_until" ]; then
        transfer_info=$(qbittorrent_api "$qbittorrent/api/v2/transfer/info" || true)
    fi
    if [ -n "$transfer_info" ]; then
        qb_external=$(json_string "$transfer_info" last_external_address_v4)
        dht_nodes=$(json_number "$transfer_info" dht_nodes)
        if [ -n "$dht_nodes" ]; then
            if [ "$dht_nodes" = "0" ]; then
                if [ -z "$dht_zero_since" ]; then
                    dht_zero_since=$now
                fi
                if [ $((now - dht_zero_since)) -ge "$stall_seconds" ]; then
                    reason="no DHT nodes for $((now - dht_zero_since))s"
                fi
            else
                dht_zero_since=
            fi
        fi
        if [ -z "$reason" ] && [ -n "$exit_ip" ] && [ -n "$qb_external" ] &&
            [ "$qb_external" != "$exit_ip" ]; then
            if [ -z "$divergence_since" ]; then
                divergence_since=$now
            fi
            if [ $((now - divergence_since)) -ge "$divergence_seconds" ]; then
                reason="qBittorrent still sees $qb_external, VPN exit is $exit_ip"
            fi
        else
            divergence_since=
        fi
    fi

    if [ -n "$reason" ]; then
        if [ $((now - last_restart)) -lt "$cooldown_seconds" ]; then
            log "skipping restart ($reason): cooldown, $((cooldown_seconds - (now - last_restart)))s left"
        elif restart_qbittorrent "$reason"; then
            last_restart=$(now_seconds)
            suppressed_until=$((last_restart + grace_seconds))
            dht_zero_since=
            divergence_since=
        else
            # The shutdown request failed, usually because qBittorrent is
            # already down. Back off like a real restart so the log does not
            # repeat the same failure every interval.
            last_restart=$(now_seconds)
        fi
    fi

    sleep "$interval"
done
