#!/bin/sh
# Runs once after Prowlarr and qBittorrent have started.
#
# Reads Prowlarr's generated API key, the qBittorrent API key seeded by
# qbittorrent-init, and the Sonarr/Radarr API keys written by the server stack,
# then wires the stack together through their APIs:
#
#   * creates the qBittorrent categories (`prowlarr`, `tv`, `movies`),
#   * registers qBittorrent as a Prowlarr download client,
#   * enables a few public indexers (EZTV, YTS, The Pirate Bay) so searches
#     work immediately,
#   * registers Sonarr and Radarr as Prowlarr applications (so Prowlarr pushes
#     its indexers to them), and
#   * registers qBittorrent in Sonarr and Radarr using the `tv`/`movies`
#     categories.
#
# Every step is idempotent. Existing download clients are updated as well as
# created, so a rotated qBittorrent API key is picked up on rerun.
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

# Prowlarr/Sonarr/Radarr serialize API lists as pretty-printed arrays. Extract
# the id of the object with the requested implementation, so an existing
# download client can be updated instead of skipped.
json_id_for_implementation() {
    implementation=$1
    awk -v wanted="$implementation" '
        /^  \},?$/ {
            if (match_impl && id != "") print id
            match_impl = 0
            id = ""
            next
        }
        {
            if ($0 ~ "\"implementation\"[[:space:]]*:[[:space:]]*\"" wanted "\"") match_impl = 1
            if (match($0, /"id"[[:space:]]*:[[:space:]]*[0-9]+/)) {
                value = substr($0, RSTART, RLENGTH)
                sub(/^.*:[[:space:]]*/, "", value)
                id = value
            }
        }
    '
}

# Pull the pretty-printed top-level provider object for a given name. The
# object boundaries are the two-space-indented braces Prowlarr emits.
json_object_for_name() {
    wanted=$1
    awk -v wanted="$wanted" '
        /^  \},?$/ {
            if (match_name) printf "%s", object
            object = ""
            match_name = 0
            next
        }
        {
            object = object $0 "\n"
            if ($0 ~ "\"name\"[[:space:]]*:[[:space:]]*\"" wanted "\"") match_name = 1
        }
    '
}

json_id_from_object() {
    sed -n 's/^[[:space:]]*"id"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\),\{0,1\}[[:space:]]*$/\1/p' | head -n 1
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

# qBittorrent 5.x stores the API key under [WebUI] as APIKey=. Older churn
# releases wrote WebUI\APIKey under [Preferences]; accept that as a fallback
# while qbittorrent-init migrates it.
qbittorrent_key=$(awk '
    /^\[/ { in_webui = ($0 == "[WebUI]"); next }
    in_webui && /^APIKey=/ { sub(/^APIKey=/, ""); print; exit }
' "$qbittorrent_config")
if [ -z "$qbittorrent_key" ]; then
    qbittorrent_key=$(sed -n 's:^WebUI\\APIKey=\(.*\)$:\1:p' "$qbittorrent_config" | head -n 1)
fi
if [ -z "$qbittorrent_key" ]; then
    echo "no qBittorrent API key in $qbittorrent_config" >&2
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
existing_id=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/downloadclient" \
    | json_id_for_implementation QBittorrent)
if [ -n "$existing_id" ]; then
    method=PUT
    target="$prowlarr/api/v1/downloadclient/$existing_id"
    id_field="\"id\": $existing_id,"
    message="updated qBittorrent in Prowlarr"
else
    method=POST
    target="$prowlarr/api/v1/downloadclient"
    id_field=
    message="registered qBittorrent as a Prowlarr download client"
fi
payload=$(mktemp)
trap 'rm -f "$payload"' EXIT INT TERM
cat >"$payload" <<EOF
{
  $id_field
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

curl -fsS -X "$method" \
    -H "X-Api-Key: $api_key" \
    -H "Content-Type: application/json" \
    --data-binary "@$payload" \
    "$target" >/dev/null

echo "$message"

# --------------------------------------------------------- Prowlarr indexers
# Public indexers need no credentials. Add them disabled first so a failed
# Prowlarr connectivity test cannot prevent the rest of the wiring; then try to
# enable each one. A failed enable leaves it disabled for a later rerun.
write_indexer_payload() {
    file=$1
    id_field=$2
    enable=$3
    name=$4
    definition=$5
    base_url=$6
    cat >"$file" <<EOF
{
  $id_field
  "enable": $enable,
  "name": "$name",
  "implementation": "Cardigann",
  "implementationName": "Cardigann",
  "configContract": "CardigannSettings",
  "appProfileId": 1,
  "priority": 25,
  "tags": [],
  "fields": [
    { "name": "definitionFile", "value": "$definition" },
    { "name": "baseUrl", "value": "$base_url" }
  ]
}
EOF
}

ensure_indexer() {
    name=$1
    definition=$2
    base_url=$3

    existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/indexer" \
        | json_object_for_name "$name")
    if [ -n "$existing" ]; then
        id=$(printf '%s\n' "$existing" | json_id_from_object)
        if [ -z "$id" ]; then
            echo "could not determine the Prowlarr id for $name" >&2
            return 1
        fi
        if printf '%s\n' "$existing" | grep -Eq '"enable"[[:space:]]*:[[:space:]]*true'; then
            echo "$name is already enabled in Prowlarr"
            return 0
        fi
        echo "$name exists in Prowlarr but is disabled; trying to enable it"
    else
        payload=$(mktemp)
        write_indexer_payload "$payload" "" false "$name" "$definition" "$base_url"
        if ! curl -fsS -X POST \
            -H "X-Api-Key: $api_key" \
            -H "Content-Type: application/json" \
            --data-binary "@$payload" \
            "$prowlarr/api/v1/indexer" >/dev/null; then
            rm -f "$payload"
            echo "could not add $name to Prowlarr" >&2
            return 1
        fi
        rm -f "$payload"

        existing=$(curl -fsS -H "X-Api-Key: $api_key" "$prowlarr/api/v1/indexer" \
            | json_object_for_name "$name")
        id=$(printf '%s\n' "$existing" | json_id_from_object)
        if [ -z "$id" ]; then
            echo "added $name to Prowlarr but could not find its id" >&2
            return 1
        fi
        echo "added $name to Prowlarr (disabled)"
    fi

    payload=$(mktemp)
    id_field="\"id\": $id,"
    write_indexer_payload "$payload" "$id_field" true "$name" "$definition" "$base_url"
    if curl -fsS -X PUT \
        -H "X-Api-Key: $api_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$prowlarr/api/v1/indexer/$id?forceSave=true" >/dev/null; then
        echo "enabled $name in Prowlarr"
    else
        echo "warning: $name is in Prowlarr but the test failed; it stays disabled" >&2
    fi
    rm -f "$payload"
}

# Override with PROWLARR_INDEXERS in torrent/.env, e.g. "eztv,yts".
# 1337x is supported but currently requires FlareSolverr, which this stack does
# not run yet; keep it out of the default set until that is added.
indexers=$(printf '%s' "${PROWLARR_INDEXERS:-eztv,yts,thepiratebay}" | tr -d '[:space:]')
old_ifs=$IFS
IFS=,
for indexer in $indexers; do
    case "$indexer" in
        1337x) name=1337x; base_url=https://1337x.to/ ;;
        eztv) name=EZTV; base_url=https://eztvx.to/ ;;
        yts) name=YTS; base_url=https://yts.gg/ ;;
        thepiratebay) name="The Pirate Bay"; base_url=https://thepiratebay.org/ ;;
        limetorrents) name=LimeTorrents; base_url=https://www.limetorrents.fun/ ;;
        "") continue ;;
        *)
            echo "unknown indexer '$indexer' in PROWLARR_INDEXERS; skipping" >&2
            continue
            ;;
    esac
    ensure_indexer "$name" "$indexer" "$base_url" || true
done
IFS=$old_ifs

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
    existing_id=$(curl -fsS -H "X-Api-Key: $sonarr_key" "$sonarr_url/api/v3/downloadclient" \
        | json_id_for_implementation QBittorrent)
    if [ -n "$existing_id" ]; then
        method=PUT
        target="$sonarr_url/api/v3/downloadclient/$existing_id"
        id_field="\"id\": $existing_id,"
        message="updated qBittorrent in Sonarr (category tv)"
    else
        method=POST
        target="$sonarr_url/api/v3/downloadclient"
        id_field=
        message="registered qBittorrent as a Sonarr download client (category tv)"
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  $id_field
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
    curl -fsS -X "$method" \
        -H "X-Api-Key: $sonarr_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$target" >/dev/null
    rm -f "$payload"
    echo "$message"
}

register_radarr_download_client() {
    existing_id=$(curl -fsS -H "X-Api-Key: $radarr_key" "$radarr_url/api/v3/downloadclient" \
        | json_id_for_implementation QBittorrent)
    if [ -n "$existing_id" ]; then
        method=PUT
        target="$radarr_url/api/v3/downloadclient/$existing_id"
        id_field="\"id\": $existing_id,"
        message="updated qBittorrent in Radarr (category movies)"
    else
        method=POST
        target="$radarr_url/api/v3/downloadclient"
        id_field=
        message="registered qBittorrent as a Radarr download client (category movies)"
    fi
    payload=$(mktemp)
    cat >"$payload" <<EOF
{
  $id_field
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
    curl -fsS -X "$method" \
        -H "X-Api-Key: $radarr_key" \
        -H "Content-Type: application/json" \
        --data-binary "@$payload" \
        "$target" >/dev/null
    rm -f "$payload"
    echo "$message"
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
