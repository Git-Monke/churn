#!/bin/sh
# Runs once before qBittorrent starts.
#
# Prowlarr needs credentials to talk to qBittorrent, but the image generates a
# random WebUI password on every start. Instead, seed (or patch) qBittorrent's
# config with a stable API key; prowlarr-init reads it from the same file and
# registers qBittorrent as Prowlarr's download client.
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

has_key() {
    [ -f "$conf" ] && grep -q '^WebUI\\APIKey=.' "$conf"
}

if has_key; then
    echo "qBittorrent config already has an API key"
else
    key=$(generate_key)
    mkdir -p "$conf_dir"

    if [ -f "$conf" ]; then
        echo "adding API key to existing qBittorrent config"

        # Make sure the section exists, then replace/insert our key inside it.
        grep -q '^\[Preferences\]' "$conf" || printf '\n[Preferences]\n' >>"$conf"

        awk -v key="$key" '
            /^\[Preferences\]/ {
                print
                if (!inserted) {
                    print "WebUI\\APIKey=" key
                    inserted = 1
                }
                in_prefs = 1
                next
            }
            /^\[/ { in_prefs = 0 }
            in_prefs && /^WebUI\\APIKey=/ { next }
            { print }
        ' "$conf" >"$conf.tmp"
        mv "$conf.tmp" "$conf"
    else
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
WebUI\Address=*
WebUI\ServerDomains=*
WebUI\APIKey=$key
EOF
    fi
fi

# The container runs qBittorrent as PUID:PGID, so it must own the seeded files.
if [ "$(id -u)" = 0 ]; then
    chown -R "$puid:$pgid" "$config_root"
fi
