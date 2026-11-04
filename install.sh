#!/bin/sh
# Install the churn installer binary from GitHub Releases.
#
#   curl -fsSL https://raw.githubusercontent.com/git-monke/churn/main/install.sh | sudo sh
#
# Overrides:
#   CHURN_REPO=owner/repo       GitHub repository to download from
#   CHURN_VERSION=0.2.0         release to install (default: latest)
#   CHURN_INSTALL_DIR=/usr/bin  destination directory (default: /usr/local/bin)
#
# The binary is static (musl), so it does not need a Node.js, npm, Rust or
# distro-library setup. churn installs Docker itself when it is missing.
#
# `sudo churn update` downloads these same release assets, verifies the same
# SHA-256 sidecar, and then updates the server dashboard.

set -eu

REPO="${CHURN_REPO:-git-monke/churn}"
VERSION="${CHURN_VERSION:-latest}"
INSTALL_DIR="${CHURN_INSTALL_DIR:-/usr/local/bin}"

fail() {
    printf 'install.sh: %s\n' "$*" >&2
    exit 1
}

[ "$(uname -s)" = "Linux" ] || fail "churn is supported on Linux only"

case "$(uname -m)" in
    x86_64 | amd64) target="x86_64-unknown-linux-musl" ;;
    aarch64 | arm64) target="aarch64-unknown-linux-musl" ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || fail "curl is required"
[ "$(id -u)" -eq 0 ] || fail "run this installer with sudo (churn needs root anyway)"

if [ "$VERSION" = "latest" ]; then
    release_path="latest/download"
else
    release_path="download/v${VERSION#v}"
fi
base="https://github.com/${REPO}/releases/${release_path}"
asset="churn-${target}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

printf 'Downloading %s ...\n' "$asset"
curl -fL --proto '=https' --tlsv1.2 -o "$tmp/$asset" "$base/$asset"
curl -fL --proto '=https' --tlsv1.2 -o "$tmp/$asset.sha256" "$base/$asset.sha256"

if command -v sha256sum >/dev/null 2>&1; then
    (cd "$tmp" && sha256sum -c "$asset.sha256")
elif command -v shasum >/dev/null 2>&1; then
    (cd "$tmp" && shasum -a 256 -c "$asset.sha256")
else
    fail "sha256sum or shasum is required to verify the download"
fi

mkdir -p "$INSTALL_DIR"
install -m 0755 "$tmp/$asset" "$INSTALL_DIR/churn"

printf '\nInstalled %s/churn\n' "$INSTALL_DIR"
printf 'Next: sudo %s/churn\n' "$INSTALL_DIR"
