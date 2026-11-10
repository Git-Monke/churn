#!/usr/bin/env bash
# Prepare and publish a release in one command.
#
# The version is taken from the newest semver tag. With no argument this bumps
# that tag by one patch version. If the newest tag is inconsistent (its tagged
# Cargo.toml does not match the tag), the tag is repaired instead, so a failed
# release can be fixed without inventing a throwaway version.
#
# Usage:
#   scripts/release.sh                 # next patch, or repair a broken newest tag
#   scripts/release.sh patch           # explicit patch bump
#   scripts/release.sh minor           # 0.1.5 -> 0.2.0
#   scripts/release.sh major           # 0.1.5 -> 1.0.0
#   scripts/release.sh 0.2.0           # exact version
#   scripts/release.sh --force 0.2.0   # re-point an existing, consistent tag
#   scripts/release.sh --no-push       # commit and tag locally only
#   scripts/release.sh --dry-run       # show what would happen
#
# The release commit contains only Cargo.toml and Cargo.lock. The script
# refuses to run with any other uncommitted changes, so commit feature work
# before releasing.
set -euo pipefail

cd "$(dirname "$0")/.."

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

spec=
force=0
push=1
dry_run=0

for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --no-push) push=0 ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    --*)
      echo "error: unknown option '$arg'" >&2
      echo "run '$0 --help' for usage" >&2
      exit 2
      ;;
    *)
      if [ -n "$spec" ]; then
        echo "error: only one version argument is allowed" >&2
        exit 2
      fi
      spec=$arg
      ;;
  esac
done

is_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

version_lt() {
  [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
}

bump_version() {
  local base=$1 part=$2 major minor patch
  IFS=. read -r major minor patch <<< "$base"
  case "$part" in
    major) printf '%s.0.0\n' "$((major + 1))" ;;
    minor) printf '%s.%s.0\n' "$major" "$((minor + 1))" ;;
    patch) printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))" ;;
  esac
}

cargo_version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)
if [ -z "$cargo_version" ]; then
  echo "error: could not read the package version from Cargo.toml" >&2
  exit 1
fi

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "error: release from main, not '$branch'" >&2
  exit 1
fi

if [ "$dry_run" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "error: working tree is not clean; commit or stash first" >&2
  exit 1
fi

# The VPN boundary is part of the release, so it is proven before any version
# math touches Cargo.toml. There is no bypass: a failure here means the stack
# could leak traffic, and nothing may be tagged or pushed.
#
# --dry-run stays static-only so a release can be rehearsed on a machine without
# /dev/net/tun or real VPN credentials. A real release always runs the live
# proof and its negative controls.
#
# A release is forced: change detection exists to keep routine runs cheap, but at
# the moment of publishing the proof is always worth the minute.
if [ "$dry_run" -eq 1 ]; then
  gate_args=(--static-only --force)
else
  gate_args=(--force)
fi
echo "gate:     scripts/vpn-gate.sh ${gate_args[*]:-}"
if ! scripts/vpn-gate.sh "${gate_args[@]+"${gate_args[@]}"}"; then
  echo "error: the VPN release gate failed; nothing was tagged or pushed" >&2
  exit 1
fi

git fetch --tags --force --quiet origin || true

latest_tag=$(
  git tag -l 'v*' --sort=-version:refname |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    head -n 1 || true
)
latest_version=${latest_tag#v}

tag_cargo_version() {
  git show "$1:Cargo.toml" 2>/dev/null |
    sed -n 's/^version = "\(.*\)"/\1/p' |
    head -n 1
}

mode=
if [ -z "$spec" ]; then
  if [ -z "$latest_tag" ]; then
    target=$cargo_version
    mode="release the current Cargo version (no tags yet)"
  elif [ "$latest_version" = "$cargo_version" ]; then
    target=$(bump_version "$latest_version" patch)
    mode="patch bump from $latest_tag"
  elif version_lt "$cargo_version" "$latest_version"; then
    tagged_cargo=$(tag_cargo_version "$latest_tag")
    if [ "$tagged_cargo" != "$latest_version" ]; then
      target=$latest_version
      mode="repair $latest_tag (tagged Cargo.toml is ${tagged_cargo:-missing})"
    else
      echo "error: Cargo.toml is $cargo_version but newest tag is $latest_tag" >&2
      echo "The tagged commit already has $latest_version; rebase or merge main first." >&2
      exit 1
    fi
  else
    target=$cargo_version
    mode="release the current Cargo version (ahead of $latest_tag)"
  fi
else
  case "$spec" in
    major|minor|patch)
      base=${latest_version:-$cargo_version}
      if ! is_semver "$base"; then
        echo "error: cannot derive a version from '$base'" >&2
        exit 1
      fi
      target=$(bump_version "$base" "$spec")
      mode="$spec bump from v$base"
      ;;
    *)
      if ! is_semver "$spec"; then
        echo "error: '$spec' is not major, minor, patch, or X.Y.Z" >&2
        exit 2
      fi
      target=$spec
      mode="explicit version"
      ;;
  esac
fi

tag="v$target"
tag_exists=0
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  tag_exists=1
fi

force_tag=0
if [ "$tag_exists" -eq 1 ]; then
  tagged_cargo=$(tag_cargo_version "$tag")
  if [ "$force" -eq 1 ]; then
    force_tag=1
  elif [ "$tagged_cargo" != "$target" ]; then
    echo "note: $tag is inconsistent (tagged Cargo.toml is ${tagged_cargo:-missing}); re-pointing it"
    force_tag=1
  else
    echo "error: tag $tag already exists and its Cargo.toml is already $target" >&2
    echo "Pass --force to re-point it, or choose another version." >&2
    exit 1
  fi
fi

if [ "$tag_exists" -eq 1 ] && [ "$force_tag" -eq 1 ]; then
  tag_action="force re-point $tag"
else
  tag_action="create annotated tag $tag"
fi

echo "release:  $target"
echo "mode:     $mode"
echo "cargo:    $cargo_version -> $target"
echo "tag:      $tag_action"
if [ "$push" -eq 1 ]; then
  echo "push:     origin $branch and $tag"
else
  echo "push:     skipped (--no-push)"
fi

if [ "$dry_run" -eq 1 ]; then
  echo "dry run:  nothing changed"
  exit 0
fi

# Only change the package version at the top of Cargo.toml.
sed -i -E '0,/^version = "[^"]+"/s//version = "'"$target"'"/' Cargo.toml

# Update only the churn package entry in Cargo.lock. Running plain `cargo
# check` here could silently update unrelated locked dependencies.
awk -v version="$target" '
  $0 == "name = \"churn\"" { in_churn = 1; print; next }
  in_churn && $1 == "version" {
    sub(/version = "[^"]*"/, "version = \"" version "\"")
    in_churn = 0
  }
  { print }
' Cargo.lock > Cargo.lock.tmp
mv Cargo.lock.tmp Cargo.lock

scripts/check-version.sh "$tag"
cargo check --locked --quiet

git add Cargo.toml Cargo.lock
if git diff --cached --quiet; then
  echo "Cargo.toml and Cargo.lock already had $target; tagging HEAD"
else
  git commit -m "Release $tag"
fi

if [ "$force_tag" -eq 1 ]; then
  git tag -f -a "$tag" -m "$tag"
else
  git tag -a "$tag" -m "$tag"
fi

if [ "$push" -eq 0 ]; then
  echo "Prepared $tag locally at $(git rev-parse --short HEAD)"
  echo "VPN gate: $(pwd)/.churn-state/vpn-gate.json"
  echo "Push it with:"
  if [ "$force_tag" -eq 1 ]; then
    echo "  git push origin $branch"
    echo "  git push --force origin refs/tags/$tag"
  else
    echo "  git push origin $branch"
    echo "  git push origin refs/tags/$tag"
  fi
  exit 0
fi

git push origin "$branch"
if [ "$force_tag" -eq 1 ]; then
  git push --force origin "refs/tags/$tag"
else
  git push origin "refs/tags/$tag"
fi

echo "Published $tag from $(git rev-parse --short HEAD)"
echo "VPN gate: $(pwd)/.churn-state/vpn-gate.json"
echo "CI will build the binaries and publish the release after the dashboard image for $target is available."
