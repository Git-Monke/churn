#!/bin/sh
# Runs before qBittorrent starts.
#
# Prowlarr and Sonarr/Radarr need a stable API key to talk to qBittorrent, but
# the container generates a fresh WebUI key when none exists. Seed (or patch)
# the `[WebUI] APIKey` entry, which qBittorrent 5.x reads; older churn versions
# wrote `WebUI\APIKey` under `[Preferences]`, which 5.x ignores, so migrate it.
#
# Also disable qBittorrent's Host header port check. It compares the request
# port with qBittorrent's internal 8080, so publishing the WebUI on any other
# host port makes every request fail with 401. The API key still authenticates
# API calls, and the WebUI keeps its username/password.
set -eu

config_root=${QBITTORRENT_CONFIG_ROOT:-/config}
conf_dir="$config_root/qBittorrent"
conf="$conf_dir/qBittorrent.conf"
puid=${PUID:-1000}
pgid=${PGID:-1000}

# qBittorrent accepts "qbt_" followed by exactly 28 characters.
generate_key() {
    printf 'qbt_%s' "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 28)"
}

read_webui_key() {
    [ -f "$conf" ] || return 0
    awk '
        /^\[/ { in_webui = ($0 == "[WebUI]"); next }
        in_webui && /^APIKey=/ { sub(/^APIKey=/, ""); print; exit }
    ' "$conf"
}

read_legacy_key() {
    [ -f "$conf" ] || return 0
    sed -n 's/^WebUI\\APIKey=//p' "$conf" | head -n 1
}

write_webui_key() {
    key=$1
    awk -v key="$key" '
        function add_settings() {
            if (!added) {
                print "APIKey=" key
                print "HostHeaderValidation=false"
                added = 1
            }
        }
        /^\[/ {
            if ($0 == "[WebUI]") {
                print
                in_webui = 1
                add_settings()
                next
            }
            in_webui = 0
            print
            next
        }
        in_webui && /^(APIKey|HostHeaderValidation)=/ { next }
        /^WebUI\\(APIKey|HostHeaderValidation)=/ { next }
        { print }
        END {
            if (!added) {
                print ""
                print "[WebUI]"
                print "APIKey=" key
                print "HostHeaderValidation=false"
            }
        }
    ' "$conf" >"$conf.tmp"
    mv "$conf.tmp" "$conf"
}

mkdir -p "$conf_dir"

if [ -f "$conf" ]; then
    key=$(read_webui_key)
    if [ -n "$key" ]; then
        echo "qBittorrent config already has a [WebUI] API key"
        write_webui_key "$key"
    else
        key=$(read_legacy_key)
        if [ -n "$key" ]; then
            echo "migrating qBittorrent API key to [WebUI]"
        else
            key=$(generate_key)
            echo "adding API key to existing qBittorrent config"
        fi
        write_webui_key "$key"
    fi
else
    key=$(generate_key)
    echo "writing seed qBittorrent config with API key"
    cat >"$conf" <<EOF
[AutoRun]
enabled=false
program=

[LegalNotice]
Accepted=true

[Preferences]
Connection\UPnP=false
Connection\PortRangeMin=6881
Downloads\SavePath=/data/
Downloads\TempPath=/data/incomplete/

[WebUI]
Address=*
ServerDomains=*
APIKey=$key
HostHeaderValidation=false
EOF
fi

# The container runs qBittorrent as PUID:PGID, so it must own the seeded files.
if [ "$(id -u)" = 0 ]; then
    chown -R "$puid:$pgid" "$config_root"
fi
