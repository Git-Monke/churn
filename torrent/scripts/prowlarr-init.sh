#!/bin/sh
# Runs once after Prowlarr and qBittorrent have started.
#
# Reads Prowlarr's generated API key, the qBittorrent API key seeded by
# qbittorrent-init, and the Sonarr/Radarr API keys written by the server stack,
# then wires the stack together through their APIs:
#
#   * creates the qBittorrent categories (`prowlarr`, `tv`, `movies`),
#   * registers qBittorrent as a Prowlarr download client,
#   * registers Sonarr and Radarr as Prowlarr applications (so Prowlarr pushes
#     its indexers to them), and
#   * registers qBittorrent in Sonarr and Radarr using the `tv`/`movies`
#     categories.
#
# Every step is idempotent: an existing item is left alone.
#
# Same-machine assumption: Sonarr and Radarr run in the server stack on this
# same host, so their keys are read from ../server/config (mounted below) and
# all cross-stack URLs go through HOST_IP. For separate machines, see README.
set -eu

prowlarr=${PROWLARR_URL:-http://localhost:9696}
qbittorrent=${QBITTORRENT_URL:-http://localhost:8080}
prowlarr_config=${PROWLARR_CONFIG_ROOT:-/prowlarr-config}/config.xml
qbittorrent_config=${QBITTORRENT_CONFIG_ROOT:-/qbittorrent-config}/qBittorrent/qBittorrent.conf
sonarr_config=${SONARR_CONFIG_ROOT:-/sonarr-config}/config.xml
radarr_config=${RADARR_CONFIG_ROOT:-/radarr-config}/config.xml
timeout=${INIT_TIMEOUT_SECONDS:-180}
servarr_timeout=${SERVARR_TIMEOUT_SECONDS:-90}
host_ip=${HOST_IP:-}

wait_for() {
    what=$1
    shift
    started=$(date +%s)
    until "$@" >/dev/null 2>&1; do
        if [ $(($(date +%s) - started)) -ge "$timeout" ]; then
            echo "timed out after ${timeout}s waiting for $what" >&2
            return 1
        fi
        sleep 2
    done
}

read_key() {
    sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$1" | head -n 1
}

# ---------------------------------------------------------------- Prowlarr key
# Prowlarr writes its API key to config.xml during first startup.
started=$(date +%s)
api_key=
while [ -z "$api_key" ]; do
    if [ -s "$prowlarr_config" ]; then
        api_key=$(read_key "$prowlarr_config")
    fi
    if [ -n "$api_key" ]; then
        break
    fi
    if [ $(($(date +%s) - started)) -ge "$timeout" ]; then
        echo "timed out after ${timeout}s waiting for Prowlarr's API key" >&2
        exit 1
    fi
    sleep 2
done

qbittorrent_key=$(sed -n 's:^WebUI\\APIKey=\(.*\)$:\1:p' "$qbittorrent_config" | head -n 1)
if [ -z "$qbittorrent_key" ]; then
    echo "no WebUI\\APIKey in $qbittorrent_config" >&2
    exit 1
fi

wait_for "Prowlarr's API" \
    curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/system/status"
wait_for "qBittorrent's API" \
    curl -fsS -H "Authorization: Bearer $qbittorrent_key" "$qbittorrent/api/v2/app/webapiVersion"

# ------------------------------------------------------- qBittorrent categories
categories=$(curl -fsS -H "Authorization: Bearer $qbittorrent_key" \
    "$qbittorrent/api/v2/torrents/categories")
for category in prowlarr tv movies; do
    if printf '%s' "$categories" | grep -q "\"$category\""; then
        continue
    fi
    curl -fsS -X POST \
        -H "Authorization: Bearer $qbittorrent_key" \
        --data-urlencode "category=$category" \
        --data-urlencode "savePath=" \
        "$qbittorrent/api/v2/torrents/createCategory" >/dev/null
    echo "created qBittorrent category $category"
done

# ------------------------------------------------ Prowlarr download client
existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/downloadclient")
if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"QBittorrent"'; then
    echo "qBittorrent is already registered with Prowlarr"
else
    payload=$(mktemp)
    trap 'rm -f "$payload"' EXIT INT TERM
    cat >"$payload" <<EOF
{
  "enable": true,
  "protocol": "torrent",
  "priority": 1,
  "name": "qBittorrent",
  "implementation": "QBittorrent",
  "configContract": "QBittorrentSettings",
  "tags": [],
  "categories": [],
  "fields": [
    { "name": "host", "value": "localhost" },
    { "name": "port", "value": 8080 },
    { "name": "useSsl", "value": false },
    { "name": "urlBase", "value": "" },
    { "name": "apiKey", "value": "$qbittorrent_key" },
    { "name": "username", "value": "" },
    { "name": "password", "value": "" },
    { "name": "category", "value": "prowlarr" },
    { "name": "priority", "value": 0 },
    { "name": "initialState", "value": 0 },
    { "name": "sequentialOrder", "value": false },
    { "name": "firstAndLast", "value": false },
    { "name": "contentLayout", "value": 0 }
  ]
}
EOF

    curl -fsS -X POST \
        -H "X-Api-Key: $api_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$prowlarr/api/v1/downloadclient" >/dev/null

    echo "registered qBittorrent as a Prowlarr download client"
fi

# ------------------------------------------------- Sonarr and Radarr wiring
if [ -z "$host_ip" ]; then
    echo "HOST_IP is not set; skipping Sonarr/Radarr wiring" >&2
    exit 0
fi

sonarr_url=${SONARR_URL:-http://$host_ip:8989}
radarr_url=${RADARR_URL:-http://$host_ip:7878}
prowlarr_external=${PROWLARR_EXTERNAL_URL:-http://$host_ip:9696}

# The server stack may still be starting on a first run: give it a moment.
started=$(date +%s)
while [ ! -s "$sonarr_config" ] && [ ! -s "$radarr_config" ]; do
    if [ $(($(date +%s) - started)) -ge "$servarr_timeout" ]; then
        echo "no Sonarr/Radarr config found after ${servarr_timeout}s; skipping" >&2
        echo "start the server stack, then: docker compose run --rm prowlarr-init" >&2
        exit 0
    fi
    sleep 2
done

sonarr_key=
if [ -s "$sonarr_config" ]; then
    sonarr_key=$(read_key "$sonarr_config")
fi
radarr_key=
if [ -s "$radarr_config" ]; then
    radarr_key=$(read_key "$radarr_config")
fi

register_sonarr_application() {
    existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/applications")
    if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"Sonarr"'; then
        echo "Sonarr is already registered with Prowlarr"
        return 0
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  "enable": true,
  "syncLevel": "fullSync",
  "name": "Sonarr",
  "implementation": "Sonarr",
  "configContract": "SonarrSettings",
  "tags": [],
  "fields": [
    { "name": "prowlarrUrl", "value": "$prowlarr_external" },
    { "name": "baseUrl", "value": "$sonarr_url" },
    { "name": "apiKey", "value": "$sonarr_key" },
    { "name": "syncCategories", "value": [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5090] },
    { "name": "animeSyncCategories", "value": [5070] },
    { "name": "syncAnimeStandardFormatSearch", "value": true }
  ]
}
EOF
    curl -fsS -X POST \
        -H "X-Api-Key: $api_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$prowlarr/api/v1/applications" >/dev/null
    rm -f "$payload"
    echo "registered Sonarr as a Prowlarr application"
}

register_radarr_application() {
    existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/applications")
    if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"Radarr"'; then
        echo "Radarr is already registered with Prowlarr"
        return 0
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  "enable": true,
  "syncLevel": "fullSync",
  "name": "Radarr",
  "implementation": "Radarr",
  "configContract": "RadarrSettings",
  "tags": [],
  "fields": [
    { "name": "prowlarrUrl", "value": "$prowlarr_external" },
    { "name": "baseUrl", "value": "$radarr_url" },
    { "name": "apiKey", "value": "$radarr_key" },
    { "name": "syncCategories", "value": [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080, 2090] }
  ]
}
EOF
    curl -fsS -X POST \
        -H "X-Api-Key: $api_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$prowlarr/api/v1/applications" >/dev/null
    rm -f "$payload"
    echo "registered Radarr as a Prowlarr application"
}

# Sonarr/Radarr reach qBittorrent through the host, since qBittorrent only
# listens inside gluetun's namespace.
qbittorrent_host=${QBITTORRENT_HOST:-$host_ip}
qbittorrent_port=${QBITTORRENT_PORT:-8080}

register_sonarr_download_client() {
    existing=$(curl -fsS -H "X-Api-Key: $sonarr_key" "$sonarr_url/api/v3/downloadclient")
    if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"QBittorrent"'; then
        echo "qBittorrent is already registered with Sonarr"
        return 0
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  "enable": true,
  "protocol": "torrent",
  "priority": 1,
  "name": "qBittorrent",
  "implementation": "QBittorrent",
  "configContract": "QBittorrentSettings",
  "tags": [],
  "fields": [
    { "name": "host", "value": "$qbittorrent_host" },
    { "name": "port", "value": $qbittorrent_port },
    { "name": "useSsl", "value": false },
    { "name": "urlBase", "value": "" },
    { "name": "apiKey", "value": "$qbittorrent_key" },
    { "name": "username", "value": "" },
    { "name": "password", "value": "" },
    { "name": "tvCategory", "value": "tv" },
    { "name": "tvImportedCategory", "value": "" },
    { "name": "recentTvPriority", "value": 0 },
    { "name": "olderTvPriority", "value": 0 },
    { "name": "initialState", "value": 0 },
    { "name": "sequentialOrder", "value": false },
    { "name": "firstAndLast", "value": false },
    { "name": "contentLayout", "value": 0 },
    { "name": "addSeriesTags", "value": false }
  ]
}
EOF
    curl -fsS -X POST \
        -H "X-Api-Key: $sonarr_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$sonarr_url/api/v3/downloadclient" >/dev/null
    rm -f "$payload"
    echo "registered qBittorrent as a Sonarr download client (category tv)"
}

register_radarr_download_client() {
    existing=$(curl -fsS -H "X-Api-Key: $radarr_key" "$radarr_url/api/v3/downloadclient")
    if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"QBittorrent"'; then
        echo "qBittorrent is already registered with Radarr"
        return 0
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  "enable": true,
  "protocol": "torrent",
  "priority": 1,
  "name": "qBittorrent",
  "implementation": "QBittorrent",
  "configContract": "QBittorrentSettings",
  "tags": [],
  "fields": [
    { "name": "host", "value": "$qbittorrent_host" },
    { "name": "port", "value": $qbittorrent_port },
    { "name": "useSsl", "value": false },
    { "name": "urlBase", "value": "" },
    { "name": "apiKey", "value": "$qbittorrent_key" },
    { "name": "username", "value": "" },
    { "name": "password", "value": "" },
    { "name": "movieCategory", "value": "movies" },
    { "name": "movieImportedCategory", "value": "" },
    { "name": "recentMoviePriority", "value": 0 },
    { "name": "olderMoviePriority", "value": 0 },
    { "name": "initialState", "value": 0 },
    { "name": "sequentialOrder", "value": false },
    { "name": "firstAndLast", "value": false },
    { "name": "contentLayout", "value": 0 }
  ]
}
EOF
    curl -fsS -X POST \
        -H "X-Api-Key: $radarr_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$radarr_url/api/v3/downloadclient" >/dev/null
    rm -f "$payload"
    echo "registered qBittorrent as a Radarr download client (category movies)"
}

if [ -n "$sonarr_key" ] && wait_for "Sonarr's API" \
    curl -fsS -H "X-Api-Key: $sonarr_key" "$sonarr_url/api/v3/system/status"; then
    register_sonarr_application
    register_sonarr_download_client
else
    echo "skipping Sonarr wiring (no API key or API unreachable)" >&2
fi

if [ -n "$radarr_key" ] && wait_for "Radarr's API" \
    curl -fsS -H "X-Api-Key: $radarr_key" "$radarr_url/api/v3/system/status"; then
    register_radarr_application
    register_radarr_download_client
else
    echo "skipping Radarr wiring (no API key or API unreachable)" >&2
fi
