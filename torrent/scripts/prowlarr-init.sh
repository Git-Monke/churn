#!/bin/sh
# Runs once after Prowlarr and qBittorrent have started.
#
# Reads Prowlarr's generated API key and the qBittorrent API key seeded by
# qbittorrent-init, then registers qBittorrent as a download client via
# Prowlarr's API. Exits without changes when the client is already configured.
set -eu

prowlarr=${PROWLARR_URL:-http://localhost:9696}
qbittorrent=${QBITTORRENT_URL:-http://localhost:8080}
prowlarr_config=${PROWLARR_CONFIG_ROOT:-/prowlarr-config}/config.xml
qbittorrent_config=${QBITTORRENT_CONFIG_ROOT:-/qbittorrent-config}/qBittorrent/qBittorrent.conf
timeout=${INIT_TIMEOUT_SECONDS:-180}

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

# Prowlarr writes its API key to config.xml during first startup.
started=$(date +%s)
api_key=
while [ -z "$api_key" ]; do
    if [ -s "$prowlarr_config" ]; then
        api_key=$(sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$prowlarr_config" | head -n 1)
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

existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/downloadclient")
if printf '%s' "$existing" | grep -Eq '"implementation"[[:space:]]*:[[:space:]]*"QBittorrent"'; then
    echo "qBittorrent is already registered with Prowlarr"
    exit 0
fi

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
