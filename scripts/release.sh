#!/usr/bin/env bash
# Bump the Cargo version, commit it, and create/push the matching release tag.
#
# Usage:
#   scripts/release.sh 0.1.4
#   scripts/release.sh 0.1.4 --force   # re-point an existing tag
#
# The dashboard image and the churn binary both derive their version from
# Cargo.toml. Tagging first is what caused v0.1.4 to fail CI: the tag was
# created while Cargo.toml still said 0.1.3. This script keeps them together.
set -euo pipefail

cd "$(dirname "$0")/.."

version=${1:-}
force=${2:-}
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <major.minor.patch> [--force]" >&2
  exit 2
fi
tag="v$version"

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "error: release from main, not '$branch'" >&2
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi

git fetch --tags --quiet origin || true
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  if [ "$force" != "--force" ]; then
    echo "error: tag $tag already exists (pass --force to re-point it)" >&2
    exit 1
  fi
  echo "re-pointing existing tag $tag"
  tag_args=(-f)
else
  tag_args=()
fi

# Only change the package version at the top of Cargo.toml.
sed -i -E '0,/^version = "[^"]+"/s//version = "'"$version"'"/' Cargo.toml

# Refresh Cargo.lock's entry for the churn package.
cargo check --quiet
scripts/check-version.sh "$tag"

git add Cargo.toml Cargo.lock
git commit -m "Release $tag"
git tag "${tag_args[@]}" -a "$tag" -m "$tag"

git push origin "$branch"
if [ "$force" = "--force" ]; then
  git push --force origin "$tag"
else
  git push origin "$tag"
fi

echo "Published $tag from $(git rev-parse --short HEAD)"
