#!/usr/bin/env bash
# Prove the VPN boundary before a release is published.
#
# The torrent stack ships with one promise: qBittorrent, Prowlarr and
# FlareSolverr can only reach the internet through the Mullvad tunnel, behind a
# kill switch that fails closed. This script is the proof of that promise.
# `scripts/release.sh` runs it before it touches a version and refuses to tag or
# push if it fails.
#
# Usage:
#   scripts/vpn-gate.sh                 # static + live + negative + restore
#   scripts/vpn-gate.sh --static-only   # deterministic checks only (CI, no tun)
#   scripts/vpn-gate.sh --force         # run even when nothing it covers changed
#   scripts/vpn-gate.sh --check-changed # exit 0 if the gate has work, 1 if not
#   scripts/vpn-gate.sh --keep          # leave the sandbox project and temp dir
#   scripts/vpn-gate.sh --verbose       # print every command
#
# Change detection:
#   The gate only covers the torrent stack, so it is skipped when nothing that
#   can change its verdict has moved since the last release tag (`v*`), or
#   since the last green run when no tag exists yet. release.sh passes --force,
#   because at the moment of publishing the proof is always worth the minute.
#   CI uses --check-changed to decide whether to schedule the job at all.
#   Set VPN_GATE_FORCE=1 to override the same way --force does.
#
# For debugging a single stage (the stages still run in order):
#   VPN_GATE_ONLY=static   scripts/vpn-gate.sh
#   VPN_GATE_ONLY=negative scripts/vpn-gate.sh    # brings the sandbox up first
#   VPN_GATE_ONLY=restore  scripts/vpn-gate.sh
#
# Stages:
#   1. static    fmt, clippy -D warnings, cargo test, the real compose file plus
#                one rendered variant per known leak path, shell syntax/lint
#   2. live      the whole pinned stack in an isolated Compose project: the
#                fail-closed vpn-check passes, vpn-status reports secure:true,
#                and a probe inside the shared namespace exits via Mullvad
#   3. negative  each control, when broken, makes the checks fail closed: a DNS
#                leak, a public HOST_IP, a broken kill switch, a blackholed
#                tunnel
#   4. restore   a freshly created namespace is secure again, then the sandbox is
#                removed and .churn-state/vpn-gate.json is written
#
# Requirements for the live stages: Docker, /dev/net/tun, and WireGuard
# credentials in torrent/.env (or VPN_GATE_ENV=<path>). The gate only ever uses
# the Compose project `churn-vpn-gate`, host ports 18080/19696/18098 and a temp
# DOWNLOAD_DIR/MEDIA_DIR, so a run cannot touch an installed stack.
#
# There is deliberately no flag that skips a stage silently: --static-only says
# what it does, and release.sh never passes it for a real release.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly PROJECT=churn-vpn-gate
readonly GATE_DIR=.churn-state
readonly ARTIFACT=.churn-state/vpn-gate.json
readonly FIXTURE_ENV=tests/vpn-gate/fixture.env
readonly ISOLATED_OVERRIDE=tests/vpn-gate/isolated.yml
readonly UNSAFE_DIR=tests/vpn-gate/unsafe
readonly STACK_ENV=${VPN_GATE_ENV:-torrent/.env}
readonly CONFIG_PROJECT=$PROJECT-config

static_only=0
keep=0
verbose=0
force=0
check_changed=0

usage() {
  # Print the leading comment block (everything after the shebang, up to the
  # first non-comment line) so it cannot drift from the header.
  sed -n '2,/^[^#]/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --static-only) static_only=1 ;;
    --force) force=1 ;;
    --check-changed) check_changed=1 ;;
    --keep) keep=1 ;;
    --verbose | -v) verbose=1 ;;
    --help | -h) usage; exit 0 ;;
    *)
      echo "error: unknown option '$arg'" >&2
      echo "run '$0 --help' for usage" >&2
      exit 2
      ;;
  esac
done

# The gate validates through the binary it just built, so a passing static stage
# and the shipped CLI can never disagree.
churn_bin() {
  printf '%s/debug/churn' "${CARGO_TARGET_DIR:-target}"
}

say() { printf '%s\n' "$*"; }
note() { printf '  %s\n' "$*" >&2; }

stage=start
sandbox_started=0
tmp=
started_at=
static_checked=0
cleanup_done=0

# Every captured output and log tail goes through this, so a report can never
# print the WireGuard key (a 44-character base64 blob) or a secret KEY=value.
redact() {
  sed -E \
    -e 's/[A-Za-z0-9+/]{43}=/<redacted-key>/g' \
    -e 's/((PRIVATE_KEY|PRESHARED_KEY|WIREGUARD_KEY)[[:space:]]*[=:][[:space:]]*)[^[:space:]]*/\1<redacted>/g'
}

compose() {
  docker compose -p "$PROJECT" --env-file "$STACK_ENV" \
    -f torrent/docker-compose.yml -f "$ISOLATED_OVERRIDE" "$@"
}

container_name() { printf '%s-%s-1' "$PROJECT" "$1"; }

# Paths whose contents can change what the gate concludes. This mirrors
# fingerprint(): everything that feeds the artifact hash must be listed here, or
# a change to it would skip the very proof that is supposed to cover it. The
# rules that judge the stack live in src/security.rs, and the renderer that
# feeds them is src/system.rs — validating the compose file with a weakened
# validator is the exact failure this list exists to prevent.
gate_inputs() {
  cat <<'EOF'
torrent
src/security.rs
src/system.rs
src/main.rs
scripts/vpn-gate.sh
tests/vpn-gate
EOF
}

# Uncommitted work counts too: a release or a runner can gate a working tree,
# and skipping it on the strength of a clean HEAD would be a lie.
dirty_paths() {
  {
    git diff --name-only HEAD 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sed '/^$/d'
}

# Newest semver release tag. `--sort=-version:refname` puts v0.10.0 above
# v0.9.0; a plain string sort would get that wrong.
newest_release_tag() {
  git tag -l 'v*' --sort=-version:refname 2>/dev/null |
    grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' |
    head -n 1 || true
}

# The commit to compare against, or empty when there is nothing to compare to.
#
# A release tag is the honest base ("has the stack moved since the release we
# last proved?"), and it exists in CI. Without one, the commit of the last green
# run is the next best thing — the artifact is machine-local, so a fresh clone
# simply gets a full run instead of a guess.
change_base() {
  local tag sha
  tag=$(newest_release_tag)
  if [ -n "$tag" ] && git rev-parse --verify --quiet "$tag^{commit}" >/dev/null 2>&1; then
    printf '%s' "$tag"
    return 0
  fi
  [ -r "$ARTIFACT" ] || return 0
  sha=$(jq -r '.gitSha // empty' "$ARTIFACT" 2>/dev/null || true)
  [ -n "$sha" ] || return 0
  git rev-parse --verify --quiet "$sha^{commit}" >/dev/null 2>&1 && printf '%s' "$sha"
}

# A stale entry is worse than no entry: a renamed file would silently stop being
# covered. This runs whenever the list is used, so a rename fails loudly instead
# of quietly narrowing the gate.
check_gate_inputs_exist() {
  local pattern missing=0
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    if [ -e "$pattern" ]; then
      continue
    fi
    printf 'error: gate input %s does not exist; update gate_inputs() in %s\n' \
      "$pattern" "$0" >&2
    missing=$((missing + 1))
  done <<EOF
$(gate_inputs)
EOF
  [ "$missing" -eq 0 ]
}

path_is_gate_input() {
  local file=$1 pattern
  while IFS= read -r pattern; do
    [ -n "$pattern" ] || continue
    case $file in
      "$pattern" | "$pattern"/*) return 0 ;;
    esac
  done <<EOF
$(gate_inputs)
EOF
  return 1
}

# Exit 0 when there is something to prove, 1 when the gate can be skipped.
# The reason is always printed, so a skipped gate cannot be mistaken for a
# passed one.
gate_has_work() {
  local base sha changed file hits=0 shown=0

  # Fail closed on a stale list: an input that no longer exists means the gate
  # silently stopped covering it.
  if ! check_gate_inputs_exist; then
    return 0
  fi

  if [ "$force" = 1 ] || [ "${VPN_GATE_FORCE:-0}" = 1 ]; then
    say "gate:     forced (--force or VPN_GATE_FORCE=1)"
    return 0
  fi

  sha=$(git rev-parse --verify --quiet HEAD 2>/dev/null || true)
  if [ -z "$sha" ]; then
    say "gate:     no git HEAD, so there is nothing to compare against"
    return 0
  fi

  base=$(change_base)
  if [ -z "$base" ]; then
    say "gate:     no release tag or recorded run to compare against"
    return 0
  fi

  # Two-dot, not three-dot: this compares the two trees, which is exactly the
  # question ("does the tree the gate judges differ?"). A merge-base diff can
  # hide changes that landed on both sides.
  changed=$(
    {
      git diff --name-only "$base" HEAD 2>/dev/null || true
      dirty_paths
    } | sed '/^$/d' | sort -u
  )

  while IFS= read -r file; do
    [ -n "$file" ] || continue
    path_is_gate_input "$file" || continue
    hits=$((hits + 1))
    # Enough to recognise the change without dumping a whole tree of fixtures.
    if [ "$shown" -lt 3 ]; then
      printf 'changed:  %s\n' "$file"
      shown=$((shown + 1))
    fi
  done <<EOF
$changed
EOF

  [ "$hits" -eq 0 ] && {
    say "gate:     nothing it covers changed since $base"
    return 1
  }
  [ "$hits" -le 3 ] || say "changed:  ... and $((hits - 3)) more"
  say "gate:     $hits path(s) changed since $base"
  return 0
}

show_log() {
  local path=$1
  if [ -s "$path" ]; then
    printf '\n--- %s (last 25 lines) ---\n' "${path#"$tmp"/}" >&2
    tail -n 25 "$path" | redact >&2 || true
  fi
}

dump_diagnostics() {
  [ -n "$tmp" ] && [ -d "$tmp" ] || return 0
  [ "$sandbox_started" = 1 ] || return 0
  printf '\n--- sandbox project ---\n' >&2
  compose ps 2>&1 | redact >&2 || true
  local id
  for id in $(compose ps -a -q 2>/dev/null || true); do
    printf '\n--- logs %s ---\n' "$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||' || echo "$id")" >&2
    docker logs --tail 25 "$id" 2>&1 | redact >&2 || true
  done
  show_log "$tmp/up.log"
}

fail() {
  local what=$1
  shift || true
  printf '\nVPN GATE FAILED in stage %s: %s\n' "$stage" "$what" >&2
  if [ "$#" -gt 0 ] && [ -n "$1" ]; then
    printf '  %s\n' "$1" >&2
  fi
  dump_diagnostics || true
  exit 1
}

step() {
  local what=$1
  shift
  if [ "$verbose" = 1 ]; then
    printf '+ %s\n' "$*" >&2
  fi
  "$@" || fail "$what" "command failed: $*"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    fail "$1 is required" "install $1 and re-run"
}

# Resolve the toolchain before anything else. `cargo fmt` and `cargo clippy` are
# separate executables that cargo finds on PATH, so a distribution cargo (for
# example /usr/bin/cargo without the rustup components) can fail with
# "no such command: fmt" while `rustc` and `cargo` still look installed.
#
# The rule is: leave a toolchain that already works alone, and only reorder PATH
# when the ambient one is incomplete or mixed. Moving a different cargo ahead of
# the one the user builds with silently changes the compiler, which invalidates
# target/ (E0514, read as a code problem) and breaks the gate for no reason.

# The commit of the rustc a tool was built from: rustc prints 9 hex characters,
# rustfmt and clippy-driver print 10; the 9-character prefix identifies the
# compiler.
rustc_commit_of() {
  "$@" --version 2>/dev/null |
    sed -nE 's/.*\(([0-9a-f]{9}).*/\1/p' | head -n 1
}

# cargo, rustc, rustfmt and clippy-driver must all come from one rustc. A
# distribution rustc with rustup-provided fmt/clippy looks installed but fails
# with E0514 inside unrelated dependencies, so compare the commits.
toolchain_is_consistent() {
  local rustc_commit clippy_commit fmt_commit
  rustc_commit=$(rustc_commit_of rustc)
  [ -n "$rustc_commit" ] || return 1
  clippy_commit=$(rustc_commit_of clippy-driver)
  [ "$clippy_commit" = "$rustc_commit" ] || return 1
  fmt_commit=$(rustc_commit_of rustfmt)
  [ "$fmt_commit" = "$rustc_commit" ] || return 1
}

# Every piece resolves, and they agree on the compiler.
toolchain_usable() {
  local tool
  for tool in cargo rustc cargo-fmt cargo-clippy clippy-driver rustfmt; do
    command -v "$tool" >/dev/null 2>&1 || return 1
  done
  toolchain_is_consistent
}

# All four executables live in one directory (a rustup toolchain bin, or a
# distribution install that ships the components).
toolchain_dir_complete() {
  [ -x "$1/cargo" ] && [ -x "$1/rustc" ] &&
    [ -x "$1/cargo-fmt" ] && [ -x "$1/cargo-clippy" ]
}

# A build cache filled by another rustc fails with E0514, which reads like a code
# error. `.rustc_info.json` cannot answer this: cargo rewrites it on every
# invocation, so a `cargo fmt` that never touches an artifact is enough to make
# it claim a match while target/debug still holds objects from another compiler.
# Detect the failure itself and retry in a cache the gate owns.
e0514_seen() { [ -f "$1" ] && grep -q 'E0514' "$1"; }

isolate_target_cache() {
  local current isolated
  current=$(rustc_commit_of rustc)
  [ -n "$current" ] || return 1
  isolated=$GATE_DIR/target-$current
  # Already isolated: a retry cannot help.
  [ "${CARGO_TARGET_DIR:-}" != "$isolated" ] || return 1
  export CARGO_TARGET_DIR=$isolated
  mkdir -p "$CARGO_TARGET_DIR"
  note "the build cache was filled by a different rustc; retrying in $CARGO_TARGET_DIR"
}

# Run a cargo step, retrying once in an isolated cache when the only problem is a
# stale one. Everything else fails exactly as it did before.
rust_step() {
  local what=$1 hint=$2 log
  shift 2
  log=$tmp/cargo.log
  if [ "$verbose" = 1 ]; then
    printf '+ %s\n' "$*" >&2
  fi
  if ! "$@" >"$log" 2>&1; then
    if ! { e0514_seen "$log" && isolate_target_cache; } || ! "$@" >"$log" 2>&1; then
      tail -n 40 "$log" >&2
      if e0514_seen "$log"; then
        fail "$what could not run" \
          "E0514: ${CARGO_TARGET_DIR:-target} was filled by a different rustc; remove it or set CARGO_TARGET_DIR"
      fi
      fail "$what" "$hint"
    fi
  fi
}

pin_toolchain() {
  # An explicit choice always wins.
  if [ -n "${CHURN_TOOLCHAIN_BIN:-}" ]; then
    if toolchain_dir_complete "$CHURN_TOOLCHAIN_BIN"; then
      export PATH="$CHURN_TOOLCHAIN_BIN:$PATH"
      say "toolchain: $CHURN_TOOLCHAIN_BIN (CHURN_TOOLCHAIN_BIN)"
      return 0
    fi
    note "note: CHURN_TOOLCHAIN_BIN=$CHURN_TOOLCHAIN_BIN is not a complete toolchain; ignoring it"
  fi

  # Nothing to fix when the ambient toolchain already works.
  if toolchain_usable; then
    say "toolchain: $(command -v cargo | sed 's|/cargo$||') (already on PATH)"
    return 0
  fi

  local candidate
  for candidate in "$HOME/.cargo/bin" /usr/local/bin /usr/bin; do
    [ -n "$candidate" ] || continue
    if toolchain_dir_complete "$candidate"; then
      export PATH="$candidate:$PATH"
      say "toolchain: $candidate"
      return 0
    fi
  done
  # No complete toolchain found: use whatever is on PATH and let the stage
  # checks report exactly which piece is missing.
  return 0
}

# Optional stage filter for debugging. Empty means every stage runs, which is
# what release.sh does.
requested=${VPN_GATE_ONLY:-}

wants() {
  [ -z "$requested" ] && return 0
  case ",$requested," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

needs_sandbox() {
  wants live || wants negative || wants restore
}

# ── stage 1: static ─────────────────────────────────────────────────────────

# Render the shipped compose file with the committed fixture env (fake values;
# no credentials are needed to render a compose file).
render_variant() {
  local out=$1
  local overrides=$2   # comma separated paths, or empty
  local extra_env=$3   # space separated KEY=VALUE, or "-" / empty
  local -a files=() envs=()
  if [ -n "$overrides" ]; then
    local file
    IFS=',' read -r -a files <<<"$overrides"
    local -a expanded=()
    for file in "${files[@]}"; do
      expanded+=(-f "$file")
    done
    files=("${expanded[@]}")
  fi
  if [ -n "$extra_env" ] && [ "$extra_env" != "-" ]; then
    local pair
    for pair in $extra_env; do
      envs+=("$pair")
    done
  fi
  if ! env "${envs[@]+"${envs[@]}"}" docker compose -p "$CONFIG_PROJECT" \
    --env-file "$FIXTURE_ENV" -f torrent/docker-compose.yml \
    "${files[@]+"${files[@]}"}" config --format json >"$out" 2>"$out.err"; then
    redact <"$out.err" >&2
    return 1
  fi
}

render_base_config() {
  render_variant "$tmp/base-config.json" '' '' ||
    fail "the shipped compose file does not render" "docker compose config failed"
}

stage_static() {
  stage=static
  say "stage 1 · static checks"

  require_command cargo
  require_command rustc
  # A cargo/clippy/rustc mismatch fails deep inside unrelated dependencies with
  # E0514, which reads like a code problem. Detect it here and say what to do.
  say "  toolchain: $(cargo --version), $(rustc --version)"
  local rustc_commit
  # clippy prints a 10-character commit, rustc prints 9; the 9-char prefix is
  # what identifies the compiler.
  rustc_commit=$(rustc --version | sed -E 's/^rustc [^ ]+ \(([0-9a-f]{9}).*/\1/')
  if command -v clippy-driver >/dev/null 2>&1; then
    local clippy_commit
    clippy_commit=$(clippy-driver --version | sed -E 's/.*\(([0-9a-f]{9}).*/\1/')
    say "  clippy:    $(clippy-driver --version)"
    if [ "$clippy_commit" != "$rustc_commit" ]; then
      fail "clippy and rustc come from different toolchains" \
        "clippy-driver is $clippy_commit but rustc is $rustc_commit; run 'rustup component add clippy' for the same toolchain (and 'cargo clean') before releasing"
    fi
  fi

  step "cargo fmt --check" cargo fmt --check
  rust_step "cargo clippy" "the gate treats warnings as errors; see above" \
    cargo clippy --locked --all-targets -- -D warnings
  rust_step "cargo test" "command failed: cargo test --locked" cargo test --locked
  rust_step "cargo build" "command failed: cargo build --locked --quiet" \
    cargo build --locked --quiet

  local script
  for script in torrent/scripts/*.sh; do
    step "sh -n $script" sh -n "$script"
  done
  for script in scripts/*.sh; do
    step "bash -n $script" bash -n "$script"
  done
  if command -v shellcheck >/dev/null 2>&1; then
    step "shellcheck" shellcheck -x scripts/*.sh torrent/scripts/*.sh
  else
    say "  note: shellcheck is not installed here; CI installs and runs it"
  fi

  say "  validating torrent/docker-compose.yml"
  if ! "$(churn_bin)" verify-vpn --env-file "$FIXTURE_ENV" \
    >"$tmp/verify-vpn.log" 2>&1; then
    show_log "$tmp/verify-vpn.log"
    fail "the shipped compose file does not isolate the torrent stack" \
      "run: $(churn_bin) verify-vpn --env-file $FIXTURE_ENV"
  fi

  local cases=$UNSAFE_DIR/cases.tsv
  [ -f "$cases" ] || fail "cases.tsv is missing" "expected $cases"

  local id expected overrides extra_env overrides_paths
  while IFS=$'\t' read -r id expected overrides extra_env; do
    case "${id:-}" in '' | '#'*) continue ;; esac
    [ -n "${expected:-}" ] || fail "malformed case list" "row '$id' has no expected message"

    overrides_paths=
    if [ "${overrides:--}" != "-" ]; then
      local name path
      for name in ${overrides//,/ }; do
        path=$UNSAFE_DIR/$name
        [ -f "$path" ] || fail "case '$id' points at a missing override" "$path"
        overrides_paths=${overrides_paths:+$overrides_paths,}$path
      done
    fi

    if ! render_variant "$tmp/case.json" "$overrides_paths" "${extra_env:--}"; then
      fail "unsafe case '$id' could not be rendered" \
        "a broken override proves nothing about the boundary"
    fi
    if "$(churn_bin)" verify-vpn --config "$tmp/case.json" \
      >"$tmp/case.out" 2>&1; then
      fail "unsafe case '$id' was ACCEPTED" "expected a rejection mentioning: $expected"
    fi
    if ! grep -qF -- "$expected" "$tmp/case.out"; then
      show_log "$tmp/case.out"
      fail "unsafe case '$id' was rejected for the wrong reason" "expected: $expected"
    fi
    static_checked=$((static_checked + 1))
  done <"$cases"
  [ "$static_checked" -gt 0 ] || fail "no unsafe layouts were checked" "cases.tsv listed nothing"

  say "  $static_checked known-unsafe layouts rejected; the shipped file passes"
}

# ── the live layer ──────────────────────────────────────────────────────────

live_preflight() {
  stage=live
  require_command docker
  require_command curl
  command -v jq >/dev/null 2>&1 ||
    fail "jq is required" "the live checks parse JSON with jq; install it and re-run"
  docker info >/dev/null 2>&1 ||
    fail "cannot talk to the Docker daemon" \
      "is it running, and is this user in the docker group?"
  [ -e /dev/net/tun ] ||
    fail "/dev/net/tun is missing" "Gluetun needs a tun device; the live gate cannot run without it"
  [ -f "$STACK_ENV" ] ||
    fail "$STACK_ENV is missing" "churn writes torrent/.env; set VPN_GATE_ENV=<path> to use another file"
}

# Export only what the stack needs. Values are never printed.
load_stack_env() {
  local key value
  for key in WIREGUARD_PRIVATE_KEY WIREGUARD_ADDRESSES SERVER_COUNTRIES HOST_IP \
    TZ PUID PGID FLARESOLVERR_URL; do
    value=$(sed -n "s/^$key=//p" "$STACK_ENV" | tail -n 1)
    if [ -n "$value" ]; then
      export "$key=$value"
    fi
  done
  [ -n "${WIREGUARD_PRIVATE_KEY:-}" ] ||
    fail "no WireGuard key in $STACK_ENV" "WIREGUARD_PRIVATE_KEY is empty"
  [ -n "${WIREGUARD_ADDRESSES:-}" ] ||
    fail "no tunnel address in $STACK_ENV" "WIREGUARD_ADDRESSES is empty"
  case "${WIREGUARD_PRIVATE_KEY}" in
    AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= | *churn*first*)
      fail "torrent/.env still holds the fixture placeholder key" \
        "generate a real Mullvad WireGuard config before releasing"
      ;;
  esac
}

inspect_status() {
  docker inspect -f \
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$(container_name "$1")" 2>/dev/null || echo missing
}

inspect_exit() {
  docker inspect -f '{{.State.ExitCode}}' "$(container_name "$1")" 2>/dev/null || echo missing
}

# Wait for a long-running service to be healthy (or simply running, when the
# image ships no healthcheck).
wait_for_healthy() {
  local service=$1 timeout=$2 deadline state
  deadline=$((SECONDS + timeout))
  state=missing
  while [ "$SECONDS" -lt "$deadline" ]; do
    state=$(inspect_status "$service")
    case "$state" in
      healthy | running) return 0 ;;
      unhealthy | dead) fail "$service is $state" "see its logs below" ;;
      exited)
        fail "$service exited instead of staying up" \
          "exit code $(inspect_exit "$service")"
        ;;
    esac
    sleep 2
  done
  fail "$service never became healthy" "timed out after ${timeout}s (last state: $state)"
}

# Wait for a one-shot service to exit 0.
wait_for_exit_zero() {
  local service=$1 timeout=$2 deadline state code
  deadline=$((SECONDS + timeout))
  state=missing
  while [ "$SECONDS" -lt "$deadline" ]; do
    state=$(inspect_status "$service")
    if [ "$state" = exited ]; then
      code=$(inspect_exit "$service")
      if [ "$code" = 0 ]; then
        return 0
      fi
      fail "$service exited non-zero" "exit code $code"
    fi
    case "$state" in
      dead) fail "$service died" "state: $state" ;;
    esac
    sleep 2
  done
  fail "$service never finished" "timed out after ${timeout}s (last state: $state)"
}

# `docker compose up` occasionally loses a race with the daemon while creating a
# container ("unable to apply cgroup configuration ... Remote peer disconnected",
# runc create failures). That is a host-side flake during startup, not a
# statement about the VPN boundary, so it is retried. Every security assertion
# stays unretried: a check that fails means the boundary failed.
transient_start_error() {
  grep -qE 'Remote peer disconnected|unable to apply cgroup configuration|runc create failed|failed to create shim task|cgroup configuration' "$1"
}

up_with_retry() {
  local log=$1 attempt=1 max=3
  shift
  while :; do
    if compose up -d "$@" >"$log" 2>&1; then
      return 0
    fi
    if [ "$attempt" -ge "$max" ] || ! transient_start_error "$log"; then
      return 1
    fi
    note "container startup raced the Docker daemon; retrying ($attempt/$max)"
    sleep 3
    attempt=$((attempt + 1))
  done
}

start_stack() {
  load_stack_env
  # It must be impossible for these to describe the installed stack.
  export QBITTORRENT_PORT=18080
  export PROWLARR_PORT=19696
  export VPN_STATUS_PORT=18098
  export DOWNLOAD_DIR=$tmp/data
  export MEDIA_DIR=$tmp/media
  export VPN_GATE_TMP=$tmp
  mkdir -p "$tmp/data" "$tmp/media" "$tmp/config/qbittorrent" "$tmp/config/prowlarr" \
    "$tmp/server-config/sonarr" "$tmp/server-config/radarr"

  sandbox_started=1
  if ! up_with_retry "$tmp/up.log"; then
    show_log "$tmp/up.log"
    fail "the sandbox stack did not start" "docker compose up -d failed"
  fi
  wait_for_healthy gluetun 240
  wait_for_exit_zero vpn-check 240
  wait_for_healthy vpn-status 180
}

vpn_check_log() {
  docker logs "$(container_name vpn-check)" >"$tmp/vpn-check.log" 2>&1 || true
}

assert_vpn_check_passed() {
  vpn_check_log
  if ! grep -q 'PASS: torrent egress is confined to the VPN' "$tmp/vpn-check.log"; then
    show_log "$tmp/vpn-check.log"
    fail "vpn-check did not report PASS" "the fail-closed gate refused the namespace"
  fi
}

status_json() {
  curl -fsS --max-time 20 "http://127.0.0.1:18098/status"
}

# Poll until the live document reports secure:true with every check true.
#
# Coverage (which torrent apps are reachable inside the tunnel) is recorded but
# deliberately NOT a gate condition: a browser crashing inside FlareSolverr is
# an application bug, not a VPN leak, and coupling the two would mean the
# security proof could be blocked by anything unrelated. It is reported loudly
# so a release notes that an app was down, and written to the artifact.
assert_secure_status() {
  local deadline=$((SECONDS + 90)) doc
  while [ "$SECONDS" -lt "$deadline" ]; do
    if doc=$(status_json 2>"$tmp/status.err") &&
      printf '%s' "$doc" | jq -e '.secure == true' >/dev/null 2>&1; then
      if ! printf '%s' "$doc" | jq -e \
        '.checks.mullvadExit and .checks.killSwitch and .checks.dns and
         .checks.ipv6 and .checks.firewallException' >/dev/null 2>&1; then
        printf '%s' "$doc" >"$tmp/status.json"
        jq '.checks' "$tmp/status.json" >&2 || true
        fail "vpn-status reports an insecure namespace" "one or more checks are false"
      fi
      printf '%s' "$doc" >"$tmp/status.json"
      report_coverage
      return 0
    fi
    sleep 3
  done
  [ -s "$tmp/status.json" ] && jq '{secure, checks, coverage}' "$tmp/status.json" >&2 || true
  show_log "$tmp/status.err"
  fail "vpn-status did not report secure:true" "timed out after 90s"
}

# Not a gate condition (see assert_secure_status), but never silent: an app that
# cannot be reached inside the tunnel is a broken install and the release notes
# should say so.
report_coverage() {
  local down
  down=$(jq -r '[.coverage[] | select(.reachable == false) | .id] | join(", ")' \
    "$tmp/status.json" 2>/dev/null || true)
  if [ -z "$down" ]; then
    say "  coverage: qbittorrent, prowlarr, flaresolverr all reachable inside the tunnel"
    return 0
  fi
  note "WARNING: not reachable inside the tunnel: $down"
  note "this is an application fault, not a VPN leak; the security checks above still hold"
}

# The exit must be Mullvad, not merely "some network", and the reported public
# address must be a public address (a private or missing one would mean the
# request never left the tunnel).
assert_mullvad_exit() {
  jq -e '.mullvad.mullvad_exit_ip == true' "$tmp/status.json" >/dev/null 2>&1 ||
    { jq '.mullvad' "$tmp/status.json" >&2 || true
      fail "the public exit is not a Mullvad exit" "vpn-status reported a non-Mullvad egress"; }

  jq -e '.mullvad.ip | type == "string" and length > 0' "$tmp/status.json" >/dev/null 2>&1 ||
    { jq '.mullvad' "$tmp/status.json" >&2 || true
      fail "vpn-status reported no public exit address" "the exit check did not complete"; }

  if jq -e '.mullvad.ip | test("^(10\\.|127\\.|192\\.168\\.|169\\.254\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)")' \
    "$tmp/status.json" >/dev/null 2>&1; then
    jq '.mullvad.ip' "$tmp/status.json" >&2 || true
    fail "the reported public address is private" "egress is not exiting through Mullvad"
  fi
}

# Containers in the shared namespace must be in it, and a probe there must
# independently observe a Mullvad exit.
assert_namespace_membership() {
  local gluetun mode
  gluetun=$(docker inspect -f '{{.Id}}' "$(container_name gluetun)" 2>/dev/null || true)
  [ -n "$gluetun" ] || fail "the gluetun container is missing" "cannot inspect the tunnel namespace"

  local service
  for service in vpn-status qbittorrent prowlarr flaresolverr; do
    mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$(container_name "$service")" 2>/dev/null || true)
    [ "$mode" = "container:$gluetun" ] ||
      fail "$service is not in Gluetun's namespace" "NetworkMode=${mode:-missing}"
  done

  if ! docker run --rm --network "container:$gluetun" curlimages/curl:8.23.0 \
    -4 -fsS -m 20 https://am.i.mullvad.net/json >"$tmp/probe.json" 2>"$tmp/probe.err"; then
    show_log "$tmp/probe.err"
    fail "a probe in the shared namespace could not reach Mullvad" "the tunnel is not usable from the apps' namespace"
  fi
  jq -e '.mullvad_exit_ip == true' "$tmp/probe.json" >/dev/null 2>&1 ||
    { jq '{mullvad_exit_ip, ip, country}' "$tmp/probe.json" >&2 || true
      fail "the namespace probe is not a Mullvad exit" "apps would egress outside the tunnel"; }
}

stage_live() {
  stage=live
  say "stage 2 · live stack in an isolated project"
  start_stack
  assert_vpn_check_passed
  say "  vpn-check reported PASS (the fail-closed gate accepted the namespace)"
  assert_secure_status
  assert_mullvad_exit
  assert_namespace_membership
  say "  vpn-status: secure, Mullvad exit, kill switch, DNS, IPv6 all proven"
}

# ── stage 3: negative controls ──────────────────────────────────────────────

# Resolver file the throwaway check containers mount. A container that merely
# shares another container's network namespace still gets Docker's default
# /etc/resolv.conf, which is exactly what the DNS check must inspect, so the
# stack's real file is mounted explicitly. A negative case overrides this.
resolv_source=

run_check_script() {
  local script=$1 out=$2
  shift 2
  local gluetun
  gluetun=$(docker inspect -f '{{.Id}}' "$(container_name gluetun)")
  docker run --rm --network "container:$gluetun" \
    -v "${resolv_source:-$PWD/torrent/resolv.conf}:/etc/resolv.conf:ro" \
    -v "$PWD/torrent/scripts:/scripts:ro" \
    -e "HOST_IP=${HOST_IP:-}" \
    -e "VPN_STATUS_PORT=18098" \
    -e "QBITTORRENT_URL=http://127.0.0.1:8080" \
    -e "PROWLARR_URL=http://127.0.0.1:9696" \
    "$@" \
    --entrypoint /bin/sh curlimages/curl:8.23.0 "/scripts/$script" >"$out" 2>&1
}

# `vpn-status.sh` prints HTTP headers before the JSON body.
status_body_from() {
  sed -n '/^{/,$p' "$1" 2>/dev/null || true
}

assert_negative_dns_leak() {
  local leak=$PWD/$UNSAFE_DIR/resolv-dns-leak.conf
  [ -f "$leak" ] || fail "the DNS leak fixture is missing" "$leak"

  resolv_source=$leak
  local out=$tmp/negative-dns-check.log
  if run_check_script vpn-check.sh "$out"; then
    show_log "$out"
    fail "vpn-check accepted a resolv.conf with a public nameserver" "DNS could leak outside the tunnel"
  fi
  grep -q 'resolv.conf contains a non-Gluetun nameserver' "$out" ||
    { show_log "$out"; fail "vpn-check failed for the wrong reason" "expected the non-Gluetun nameserver message"; }

  local status_out=$tmp/negative-dns-status.txt
  run_check_script vpn-status.sh "$status_out" || true
  resolv_source=
  local body
  body=$(status_body_from "$status_out")
  if [ -z "$body" ] || ! printf '%s' "$body" | jq -e '.checks.dns == false' >/dev/null 2>&1; then
    show_log "$status_out"
    fail "vpn-status did not report dns:false for a leaking resolv.conf" "the dashboard would hide a DNS leak"
  fi
}

assert_negative_public_host_ip() {
  local out=$tmp/negative-host-ip.log
  if run_check_script vpn-check.sh "$out" -e HOST_IP=8.8.8.8; then
    show_log "$out"
    fail "vpn-check accepted a public HOST_IP" "FIREWALL_OUTBOUND_SUBNETS would exempt a public address"
  fi
  grep -q 'is not a loopback/LAN address' "$out" ||
    { show_log "$out"; fail "vpn-check failed for the wrong reason" "expected the HOST_IP message"; }
}

# Direct egress through the non-VPN interface, from inside the live namespace.
# Succeeds when eth0 can reach the internet, which is exactly what the shipping
# check treats as a broken kill switch.
probe_direct_egress() {
  local gluetun=$1
  docker run --rm --network "container:$gluetun" curlimages/curl:8.23.0 \
    -4 -fsS --interface eth0 -m 8 -o /dev/null http://1.1.1.1/ >/dev/null 2>&1
}

# The kill switch is only meaningful if it can be broken and noticed. This
# saboteurs the *rules* Gluetun installed inside the sandbox namespace by
# inserting a RETURN before them, so packets bound to eth0 leave; a plain ACCEPT
# would not be enough because the check binds the socket to eth0 with
# SO_BINDTODEVICE and Gluetun's own rules still drop it.
#
# The injected rule is removed immediately, and stage 4 recreates the namespace
# regardless, so nothing survives the run.
assert_negative_kill_switch() {
  local gluetun
  gluetun=$(container_name gluetun)

  docker exec -u 0 "$gluetun" sh -c 'command -v iptables' >/dev/null 2>&1 ||
    fail "iptables is not available in the pinned Gluetun image" \
      "the kill-switch negative test cannot run; see the risk note in plans/vpn-release-gate.md"

  # A positive control first: without any sabotage the check must pass, so a
  # later "failure" cannot be the check being broken for an unrelated reason.
  local out=$tmp/positive-kill-switch.log
  run_check_script vpn-check.sh "$out" ||
    { show_log "$out"; fail "vpn-check rejects its own namespace before any sabotage" \
        "the negative control below would prove nothing"; }
  if probe_direct_egress "$gluetun"; then
    fail "eth0 already reaches the internet before any sabotage" \
      "the wireguard kill switch is not active in this namespace"
  fi

  # Gluetun's OUTPUT chain ends with a DROP policy and its own ACCEPT rules; the
  # first rule decides, so an ACCEPT inserted at position 1 lets packets out of
  # eth0. (A RETURN there would fall through to the DROP policy instead, which
  # is why this must be ACCEPT — verified against gluetun v3.41.3.)
  local sabotage=(-I OUTPUT 1 -o eth0 -j ACCEPT)
  docker exec -u 0 "$gluetun" iptables "${sabotage[@]}" >/dev/null ||
    fail "could not insert the saboteur rule" "iptables ${sabotage[*]} failed"
  undo_sabotage() {
    docker exec -u 0 "$gluetun" iptables -D OUTPUT -o eth0 -j ACCEPT >/dev/null 2>&1 || true
  }

  # Prove the sabotage actually re-opened the interface before asking the
  # check about it. Without this, a rule that had no effect would look like a
  # passing negative control.
  if ! probe_direct_egress "$gluetun"; then
    undo_sabotage
    fail "the saboteur rule did not re-open eth0" \
      "the negative control is inconclusive; the pinned Gluetun image's firewall layout changed"
  fi

  out=$tmp/negative-kill-switch.log
  if run_check_script vpn-check.sh "$out"; then
    undo_sabotage
    show_log "$out"
    fail "vpn-check accepted direct eth0 egress" \
      "the kill switch would be ineffective without anyone noticing"
  fi
  if ! grep -q 'traffic through eth0 reached the internet' "$out"; then
    undo_sabotage
    show_log "$out"
    fail "vpn-check failed for the wrong reason" "expected the eth0 egress message"
  fi

  local status_out=$tmp/negative-kill-switch-status.txt
  run_check_script vpn-status.sh "$status_out" || true
  local body
  body=$(status_body_from "$status_out")
  if [ -z "$body" ] || ! printf '%s' "$body" | jq -e '.checks.killSwitch == false' >/dev/null 2>&1; then
    undo_sabotage
    show_log "$status_out"
    fail "vpn-status did not report killSwitch:false for a broken kill switch" \
      "the dashboard would hide an open bypass"
  fi
  undo_sabotage
}

# Blackhole the tunnel and prove no app has a fallback to the bare interface.
# This is the promise of a kill switch: losing the tunnel must not mean losing
# the protection. Restored by recreating the namespace in stage 4.
assert_negative_tunnel_drop() {
  local gluetun
  gluetun=$(container_name gluetun)

  # Positive control: reachable while the tunnel works.
  local service name
  for service in qbittorrent prowlarr; do
    name=$(container_name "$service")
    docker run --rm --network "container:$name" curlimages/curl:8.23.0 \
      -4 -fsS -m 10 -o /dev/null http://1.1.1.1/ ||
      fail "$service cannot reach the internet while the tunnel is up" \
        "the blackhole assertion below would prove nothing"
  done

  docker exec -u 0 "$gluetun" iptables -I OUTPUT -o tun0 -j DROP >/dev/null ||
    fail "could not blackhole the tunnel" "iptables -I OUTPUT -o tun0 -j DROP failed"

  for service in vpn-status qbittorrent prowlarr; do
    name=$(container_name "$service")
    if docker run --rm --network "container:$name" curlimages/curl:8.23.0 \
      -4 -fsS -m 5 http://1.1.1.1/ >/dev/null 2>&1; then
      docker exec -u 0 "$gluetun" iptables -D OUTPUT -o tun0 -j DROP >/dev/null 2>&1 || true
      fail "$service could reach the internet with the tunnel blackholed" \
        "traffic fell through to a non-VPN route; the kill switch is not fail-closed"
    fi
  done

  docker exec -u 0 "$gluetun" iptables -D OUTPUT -o tun0 -j DROP >/dev/null 2>&1 || true
}

stage_negative() {
  stage=negative
  say "stage 3 · negative controls (each must fail closed)"
  assert_negative_dns_leak
  say "  DNS leak: vpn-check refused it; vpn-status reported dns:false"
  assert_negative_public_host_ip
  say "  public HOST_IP: vpn-check refused it"
  assert_negative_kill_switch
  say "  broken kill switch: vpn-check refused it; vpn-status reported killSwitch:false"
  assert_negative_tunnel_drop
  say "  blackholed tunnel: no service could reach the internet"
}

# ── stage 4: restore and record ─────────────────────────────────────────────

stage_restore() {
  stage=restore
  say "stage 4 · restore and record"

  # A freshly created namespace is the honest way back: it drops every saboteur
  # rule and proves the clean state is secure again.
  if ! up_with_retry "$tmp/restore.log" --force-recreate; then
    show_log "$tmp/restore.log"
    fail "the stack could not be recreated after the negative controls" "see the log above"
  fi
  wait_for_healthy gluetun 240
  wait_for_exit_zero vpn-check 240
  wait_for_healthy vpn-status 180
  assert_vpn_check_passed
  assert_secure_status
  assert_mullvad_exit
  say "  recreated namespace: secure:true again"

  write_artifact
  say "  artifact: $ARTIFACT"
}

# What the proof covers: the files that define the boundary. Keyed on a
# fingerprint rather than HEAD, because the release commit only bumps
# Cargo.toml and Cargo.lock.
fingerprint() {
  cat \
    torrent/docker-compose.yml \
    torrent/resolv.conf \
    torrent/scripts/*.sh \
    src/security.rs \
    src/system.rs \
    src/main.rs \
    scripts/vpn-gate.sh \
    "$FIXTURE_ENV" \
    "$ISOLATED_OVERRIDE" \
    "$UNSAFE_DIR"/cases.tsv \
    "$UNSAFE_DIR"/*.yml \
    | sha256sum | cut -d' ' -f1
}

write_artifact() {
  mkdir -p "$GATE_DIR"
  local version sha finished images
  version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)
  sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  images=$(jq -r '.services[].image' "$tmp/base-config.json" | sort -u | jq -R . | jq -s .)

  jq -n \
    --arg version "$version" \
    --arg gitSha "$sha" \
    --arg fingerprint "$(fingerprint)" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$finished" \
    --argjson staticCases "$static_checked" \
    --argjson status "$(cat "$tmp/status.json")" \
    --argjson images "$images" \
    --argjson warnings "$(jq -c '[.coverage[] | select(.reachable == false) | .id]' "$tmp/status.json")" \
    '{
      version: $version,
      gitSha: $gitSha,
      fingerprint: $fingerprint,
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      static: {
        ok: true,
        unsafeLayoutsRejected: $staticCases,
        commands: [
          "cargo fmt --check",
          "cargo clippy --locked --all-targets -- -D warnings",
          "cargo test --locked",
          "churn verify-vpn --env-file tests/vpn-gate/fixture.env",
          "churn verify-vpn --config (per unsafe layout)",
          "sh -n / bash -n / shellcheck"
        ]
      },
      live: {
        secure: $status.secure,
        checks: $status.checks,
        coverage: ($status.coverage | map({ (.id): .reachable }) | add),
        images: $images
      },
      # Recorded, not gated: which torrent apps were reachable inside the
      # tunnel during the run (an app crash is not a VPN leak).
      coverageWarnings: $warnings,
      negative: {
        dnsLeak: true,
        publicHostIp: true,
        killSwitchBroken: true,
        tunnelDropped: true
      },
      restored: true
    }' >"$ARTIFACT"
}

# ── main ────────────────────────────────────────────────────────────────────

# Remove the sandbox temp tree. The linuxserver containers run as PUID/PGID
# from the env file (0 in a default install), so they create config files owned
# by root that the invoking user cannot delete. Deleting from inside a container
# sidesteps that without needing sudo, and skipping the delete would leak a
# multi-hundred-megabyte tree into /tmp on every release.
remove_tree() {
  local path=$1
  [ -n "$path" ] && [ -d "$path" ] || return 0
  if rm -rf "$path" 2>/dev/null; then
    return 0
  fi
  note "removing $path from inside a container (root-owned files)"
  # Mount the parent and delete the directory itself: a bind-mounted /gate
  # cannot be removed from within its own mount.
  # --user 0 is required: the curl image runs as non-root and cannot unlink
  # files owned by root.
  if ! docker run --rm --user 0 -v "$(dirname "$path"):/parent" \
    --entrypoint /bin/sh curlimages/curl:8.23.0 \
    -c "rm -rf /parent/$(basename "$path")" >/dev/null 2>&1; then
    printf 'could not remove %s; delete it manually\n' "$path" >&2
    return 1
  fi
  [ ! -d "$path" ] ||
    printf 'could not fully remove %s; delete it manually\n' "$path" >&2
}

cleanup() {
  [ "$cleanup_done" = 1 ] && return 0
  cleanup_done=1
  if [ "$sandbox_started" = 1 ] && [ "$keep" = 0 ]; then
    # Containers must be gone before their bind mounts can be deleted.
    compose down --remove-orphans >/dev/null 2>&1 || true
  fi
  if [ "$keep" = 1 ]; then
    printf 'kept: project %s and %s\n' "$PROJECT" "$tmp" >&2
    return 0
  fi
  remove_tree "$tmp" || true
}
trap cleanup EXIT

say "vpn gate · $(git rev-parse --short HEAD 2>/dev/null || echo 'unknown revision') · project $PROJECT"

# Asked only to answer the question, so it must not create anything.
if [ "$check_changed" = 1 ]; then
  if gate_has_work; then
    exit 0
  fi
  exit 1
fi

# Skipping is never silent: the reason is printed and the command that forces a
# full run is spelled out.
if ! gate_has_work; then
  say ""
  say "VPN gate skipped: nothing that can change its verdict moved."
  say "  rerun with: scripts/vpn-gate.sh --force"
  exit 0
fi

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/churn-vpn-gate.XXXXXX")

pin_toolchain

# The validators work on a rendered compose file, so even the static stage needs
# the Docker CLI (not the daemon). Say that plainly instead of failing inside a
# render.
stage=static
require_command docker
# Needed by the static stage and by the artifact's image list.
render_base_config

if wants static; then
  stage_static
fi

if [ "$static_only" = 1 ] || ! needs_sandbox; then
  say ""
  say "static checks passed."
  if [ "$static_only" = 1 ] || [ -n "$requested" ]; then
    say "The live proof (stages 2-4) needs Docker, /dev/net/tun and WireGuard"
    say "credentials in $STACK_ENV; scripts/release.sh always runs it."
  fi
  exit 0
fi

live_preflight
if wants live; then
  stage_live
elif [ -n "$requested" ]; then
  # The negative and restore stages need a live namespace even when the live
  # assertions are not part of this run.
  say "stage 2 · starting the sandbox for the requested stages"
  start_stack
fi
if wants negative; then
  stage_negative
fi
if wants restore; then
  stage_restore
fi

say ""
say "VPN gate passed."
say "  live:     secure:true, Mullvad exit, kill switch, DNS, IPv6 all proven"
say "  negative: DNS leak, public HOST_IP, broken kill switch, dropped tunnel all failed closed"
say "  artifact: $ARTIFACT"
