#!/usr/bin/env bash
# Verify that every place that carries the project version agrees.
#
# Usage:
#   scripts/check-version.sh              # Cargo.toml <-> Cargo.lock
#   scripts/check-version.sh v0.1.4       # ...and the release tag
set -euo pipefail

cd "$(dirname "$0")/.."

cargo_version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)
if [ -z "$cargo_version" ]; then
  echo "error: could not read the package version from Cargo.toml" >&2
  exit 1
fi

lock_version=$(awk '
  $0 == "name = \"churn\"" { found = 1; next }
  found && $1 == "version" { gsub(/"/, "", $3); print $3; exit }
' Cargo.lock)
if [ -z "$lock_version" ]; then
  echo "error: could not read the churn version from Cargo.lock" >&2
  exit 1
fi

if [ "$cargo_version" != "$lock_version" ]; then
  echo "::error::Cargo.toml is $cargo_version but Cargo.lock is $lock_version" >&2
  echo "Run 'cargo check' to refresh Cargo.lock." >&2
  exit 1
fi

if [ "${1:-}" != "" ]; then
  tag=$1
  if [ "v$cargo_version" != "$tag" ]; then
    echo "::error::tag $tag does not match Cargo version v$cargo_version" >&2
    echo "Bump Cargo.toml (and Cargo.lock) before tagging, or use scripts/release.sh." >&2
    exit 1
  fi
fi

echo "version OK: $cargo_version"
