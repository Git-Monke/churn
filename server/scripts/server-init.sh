#!/bin/sh
# Runs once after Sonarr and Radarr start.
#
# Creates the shared media folders under MEDIA_DIR (mounted at /data/media) and
# registers them as root folders through the Sonarr/Radarr APIs. Everything is
# idempotent, so the one-shot can be re-run after config changes or a partial
# install.
#
# Existing directories are never modified: churn creates what is missing and
# leaves ownership alone, so an adopted library keeps its own owner.
set -eu

media_root=${MEDIA_ROOT:-/data/media}
sonarr_url=${SONARR_URL:-http://sonarr:8989}
radarr_url=${RADARR_URL:-http://radarr:7878}
sonarr_config=${SONARR_CONFIG_ROOT:-/sonarr-config}/config.xml
radarr_config=${RADARR_CONFIG_ROOT:-/radarr-config}/config.xml
puid=${PUID:-1000}
pgid=${PGID:-1000}
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

read_key() {
    sed -n 's:.*<ApiKey>\([^<]*\)</ApiKey>.*:\1:p' "$1" | head -n 1
}

wait_for_key() {
    app=$1
    config=$2
    started=$(date +%s)
    key=
    while [ -z "$key" ]; do
        if [ -s "$config" ]; then
            key=$(read_key "$config")
        fi
        if [ -n "$key" ]; then
            break
        fi
        if [ $(($(date +%s) - started)) -ge "$timeout" ]; then
            echo "timed out after ${timeout}s waiting for ${app}'s API key" >&2
            return 1
        fi
        sleep 2
    done
    printf '%s' "$key"
}

ensure_root_folder() {
    app=$1
    url=$2
    key=$3
    path=$4

    if curl -fsS -H "X-Api-Key: $key" "$url/api/v3/rootfolder" \
        | grep -Eq "\"path\"[[:space:]]*:[[:space:]]*\"$path\""; then
        echo "$path is already a root folder in $app"
        return 0
    fi

    curl -fsS -X POST \
        -H "X-Api-Key: $key" \
        -H "Content-Type: application/json" \
        --data-binary "{\"path\":\"$path\"}" \
        "$url/api/v3/rootfolder" >/dev/null
    echo "registered $path as a root folder in $app"
}

# Create only what is missing. Never chown: the media tree may be an existing
# library owned by a different user, and silently taking it over is worse than
# a readable warning.
for dir in "$media_root" "$media_root/tv" "$media_root/movies"; do
    if [ -d "$dir" ]; then
        continue
    fi
    if mkdir -p "$dir" 2>/dev/null; then
        echo "created $dir"
    else
        echo "warning: could not create $dir" >&2
    fi
done

if [ ! -w "$media_root" ]; then
    echo "warning: $media_root is not writable by uid $(id -u) (PUID=$puid PGID=$pgid)." >&2
    echo "warning: Sonarr/Radarr imports will fail until that is fixed; churn does not change ownership." >&2
fi

sonarr_key=$(wait_for_key Sonarr "$sonarr_config")
radarr_key=$(wait_for_key Radarr "$radarr_config")

wait_for "Sonarr's API" \
    curl -fsS -H "X-Api-Key: $sonarr_key" "$sonarr_url/api/v3/system/status"
wait_for "Radarr's API" \
    curl -fsS -H "X-Api-Key: $radarr_key" "$radarr_url/api/v3/system/status"

ensure_root_folder Sonarr "$sonarr_url" "$sonarr_key" "$media_root/tv"
ensure_root_folder Radarr "$radarr_url" "$radarr_key" "$media_root/movies"
