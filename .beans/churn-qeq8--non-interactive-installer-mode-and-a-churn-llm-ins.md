---
# churn-qeq8
title: Non-interactive installer mode and a churn llm-install prompt
status: completed
type: feature
priority: high
tags:
    - installer
    - llm
    - automation
created_at: 2026-11-10T23:32:56Z
updated_at: 2026-11-13T01:55:45Z
---

## Goal

Make churn drivable by an LLM (or any script) with **no TTY**, and add a command that
teaches an LLM how to do it.

Two deliverables:

1. `churn --non-interactive` — the full install path resolves every answer from flags,
   an answers file, or the environment, and **never constructs a cliclack prompt**.
2. `churn llm-install` — prints a self-contained prompt (markdown) describing how to
   interview the user, discover the host's existing state, choose the data locations and
   VPN settings, then run `churn --non-interactive`. Generated from the binary so it
   cannot drift from the real flags/providers/keys.

## Why now

`vendor/cliclack/src/prompt/interaction.rs:66` refuses to run without a terminal:

```rust
if !term.is_term() {
    return Err(io::ErrorKind::NotConnected.into());
}
```

`ask_questions` (`src/main.rs:302`) always calls `question.ask(...)`, so `churn` under a
pipe/Dockerfile/agent-bash dies on the first prompt. `-y/--yes` only skips the final
confirm, the port prompt, and the location/OpenVPN-password prompts; it does not answer
the storage dirs, the provider picker or the WireGuard key. Today the only workaround is
a PTY (`script -qec`, `expect`, tmux), which is fragile and leaks secrets into scrollback.

## Design

### 1. `--non-interactive` (global, `CHURN_NON_INTERACTIVE=1`)

- No cliclack prompt may be constructed on this path. `intro/outro/log/spinner` stay
  (they already degrade when stderr is not a tty; `src/live.rs` proves the pattern).
- Implies `--yes` (no confirmations) and requires `--stacks` (no menu).
- Resolution order per answer: explicit flag → `--answers` file → existing `.env`
  (rerun reuse, already implemented as `defaults` in `ask_questions`) → built-in default.
  Anything still missing ⇒ **exit 2 before any write**, naming every missing key:
  `churn: non-interactive install is missing: WIREGUARD_PRIVATE_KEY, MEDIA_DIR`.
- Ports: reuse `resolve_port`'s tail (`ports::nearest_free`) but log the decision instead
  of prompting.
- `ensure_directories`: create missing dirs, keep the `storage_warning` owner warning,
  no prompt.
- Docker: `--install-docker` opt-in. Without it, missing Docker ⇒ exit 1 with the distro
  command printed. Never install packages implicitly in a scripted run.
- Jellyfin admin: `JELLYFIN_ADMIN_USER` / `JELLYFIN_ADMIN_PASSWORD` from env or answers
  file (already read first by `jellyfin_credentials`). If the startup wizard is incomplete
  and no password is supplied, generate a random one, write it to `server/.env` as
  `JELLYFIN_ADMIN_PASSWORD` with mode 0600 and report only the path — never the value.
- `--dry-run` composes with it unchanged.
- Output: human lines on stderr, one JSON object on stdout when `--json`
  (`{"ok":true,"stacks":["server","torrent"],"urls":{...}}` /
  `{"ok":false,"error":"...","missing":[...]}`). Exit codes: 0 ok, 1 runtime failure,
  2 usage/missing answers.

### 2. Answers file

`--answers <path>` or `--answers -` (stdin). Format is `.env` (`KEY=VALUE`, `#` comments)
so `envfile::parse` is reused verbatim and the keys are the ones already documented:
`DOWNLOAD_DIR`, `MEDIA_DIR`, `VPN_SERVICE_PROVIDER`, `WIREGUARD_PRIVATE_KEY`,
`WIREGUARD_ADDRESSES`, `OPENVPN_USER`, `OPENVPN_PASSWORD`, `VPN_LOCATION`,
`JELLYFIN_PORT`, `SONARR_PORT`, `RADARR_PORT`, `DASHBOARD_PORT`, `QBITTORRENT_PORT`,
`PROWLARR_PORT`, `VPN_STATUS_PORT`, `JELLYFIN_ADMIN_USER`, `JELLYFIN_ADMIN_PASSWORD`.

- Unknown keys are a warning, not an error (forward compatible).
- The file holds secrets: require mode `0600` (or refuse), and none of these values may
  ever be printed back — reuse `Question::is_secret`.
- Flags `--download-dir`, `--media-dir`, `--vpn-provider`, `--vpn-location` override the
  file for the common cases.

### 3. Code shape (deliberately small)

- New `src/answers.rs` with
  `pub fn resolve(questions: &[Question], stored: &HashMap<Question,String>, supplied: &HashMap<String,String>) -> Result<Answers, Missing>`.
  Pure, no I/O, no cliclack. Validation reuses `validate_wireguard_key`,
  `validate_wireguard_address`, `VpnProvider::validate_location`,
  `question::validate_storage_paths`, `ports::validate_port`, and
  `VpnProvider::missing_credentials`.
- `ask_questions` (`src/main.rs:302`) short-circuits:
  `if args.non_interactive { return answers::resolve(...) }` before the first prompt is
  built. **No trait/refactor of `Question::ask`** — the interactive path stays untouched.
- `src/llm.rs` for the prompt builder.

### 4. `churn llm-install`

`churn llm-install [--format md|json] [--stacks ...] [--write <path>]`, no root needed,
prints to stdout by default.

The text is composed from live data, never hand-copied: `VpnProvider::ALL` (+ `label`,
`gluetun_id`, `help`, `required_env`, `locations`, `default_location`, `protocol`),
`Stack::ALL` (+ `questions`), `Port::ALL` (defaults + env keys), `Question::ALL` (env
keys), and the real `HELP` flag list.

Prompt outline (this is the deliverable the LLM reads):

1. **Role and hard rules** — you are installing churn for this user on this machine. Never
   fabricate a credential. Never print a secret back into the conversation. Do not remove
   media, do not chown an existing library, do not run `uninstall`/`migrate --move`
   without explicit approval, do not expose services beyond the LAN/Tailscale.
2. **Discover, don't ask — then confirm** — inspect the host first, so you ask the user
   only what the machine cannot tell you: `findmnt`, `df -h`, `lsblk -f`,
   `/mnt/*`, `/data/*`, `docker ps`, existing `server/.env`/`torrent/.env`, an existing
   Jellyfin on 8096 (`curl -s localhost:8096/System/Info/Public`), existing libraries
   (`*.mkv|*.mp4` under likely roots), `ss -ltn`, `test -e /dev/net/tun`.
   **Gather everything before you install.** Before running the installer, you must have
   all of it: the download directory, the media directory (and whether it is an existing
   library to adopt), the chosen stacks, the VPN provider and its credentials plus a valid
   location, and the Jellyfin admin username and password (unless you are letting churn
   generate one). Never start an install with a hole and hope a later rerun fills it.

   **Present the whole plan and get an explicit yes.** Summarise it for the user — stacks,
   both paths (calling out an existing library you are adopting), provider, protocol and
   location, ports (including any churn will have to move), the Jellyfin admin user, where
   secrets will be written, and which commands you will run. Wait for their confirmation
   before running anything that writes or starts containers.

3. **Choose the storage layout** — pick a **sensible default yourself** from what you
   found, then confirm it with the user before using it: `DOWNLOAD_DIR` on a fast **local**
   disk (never a network fs: the compose/SQLite story), `MEDIA_DIR` on the largest disk or
   **pointed at the existing library to adopt it in place** (no copy, no restructuring, one
   mixed library). Enforce: download dir must not be inside media dir; media dir may sit
   inside the download dir (default `<DOWNLOAD_DIR>/media`). Report free space and the
   resolved owners (`PUID/PGID` come from the media dir).
4. **VPN** — ask the user for provider + credentials, since they are secrets; give the
   provider's `help()` steps and the exact keys; the location must be one of the embedded
   list (PIA uses `SERVER_REGIONS` and OpenVPN; the other five use WireGuard). Offer the
   `--answers` file route so the secret never appears in `argv`.
5. **Ports** — do not pick ports. Leave them unset and let churn do what it always does:
   keep the conventional port when it is free and move to the nearest free one when it is
   not. Only set a port when the *user* asks for a specific one.
6. **Jellyfin admin** — ask for a username/password once, or let churn generate and persist
   one; tell the user where it is (`server/.env`, mode 0600).
7. **Run and verify** — `sudo churn --non-interactive --stacks ... --answers ...`, then
   `churn show --json`, then `churn verify-vpn` (torrent stack), then report the URLs.
   Map exit code 2 ⇒ answer the listed keys and rerun; 1 ⇒ paste the error, do not
   "fix" by deleting state.
8. **Idempotency** — rerunning is safe and reuses stored answers; a rerun after changing
   `VPN_SERVICE_PROVIDER` drops the other protocol's credentials.

Also add `churn show --json` (trivial, `src/show.rs` already builds the URL table) since
the agent needs URLs without parsing the human table.

## Files

- `src/main.rs` — `Args` + `parse_args`/`validate_args` + `HELP`; new `llm-install`
  command; gate `confirm()` at `:672` (`create_if_missing`), `:811` (`ensure_docker`),
  `:1254`, `:2422`; split `jellyfin_credentials` so the non-interactive branch never
  prompts.
- `src/answers.rs` (new) — pure resolver + `Missing` error.
- `src/llm.rs` (new) — prompt builder.
- `src/show.rs` — `--json`.
- `src/lib.rs` — `pub mod answers; pub mod llm;`
- `src/envfile.rs` — small helper for mode-0600 writes (reuse `write_atomic` + perms).
- `README.md` — new "Non-interactive and LLM-driven installs" section; `docs/src/introduction.md` mention.

## Tests

- `src/answers.rs` unit tests: complete file ⇒ full `Answers`; each missing key reported
  by env key; bad provider/location/key rejected with the existing messages; provider
  switch drops the other protocol's credentials; port conflict picks `nearest_free`.
- `tests/noninteractive.rs` (all of the above landed here): `answers::resolve` against the
  real `stack::collect_questions` (proves no question is left unanswerable) and against
  every `Stack::questions`; the prompt contains every `VpnProvider::gluetun_id` and
  `required_env` key and no `*_PORT` suggestions; binary tests spawn
  `CARGO_BIN_EXE_churn` with stdin closed ⇒ exit 2 naming the missing keys and writing
  nothing, `--non-interactive` without `--stacks` ⇒ exit 2, a mode-0644 answers file ⇒
  exit 2 with the `chmod 600` hint, a mode-0600 file satisfies the resolver without
  echoing the secret, and `llm-install` writes nothing and emits one parseable JSON
  object.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` (CI parity).

## Todo

- [x] Add `answers.rs` (pure resolver) with unit tests
- [x] Add `--non-interactive`, `--answers`, `--install-docker`, dir/provider/location flags to `parse_args` + `validate_args` + `HELP`
- [x] Short-circuit `ask_questions` and gate the remaining `confirm()` calls (create_if_missing, ensure_docker, install, uninstall, migrate, update)
- [x] Non-interactive Jellyfin credentials (env → answers → generate + 0600)
- [x] Non-interactive port resolution and directory creation
- [x] `--json` output for the install result and `churn show --json`
- [x] Add `llm.rs` prompt builder, generated from `VpnProvider`/`Port`/`Question`/`Stack`
- [x] Add the `llm-install` command and dispatch
- [x] Tests: resolver, prompt coverage, no-tty binary exit 2
- [x] README + docs section, including a worked `--answers` example
- [x] Run fmt/clippy/test and leave the change in the working tree for review

## Result

Implemented, uncommitted in the working tree (awaiting review).

- `src/answers.rs` — pure resolver (`resolve`, `Unresolved`, `generate_password`). Provider
  first (it decides which credentials exist), storage paths have no default, ports are
  never a question, location is canonicalised to the provider's spelling. 11 unit tests.
- `src/main.rs` — `--non-interactive` (+ `CHURN_NON_INTERACTIVE=1`), `--answers <PATH|->`
  (mode 0600 enforced, `-` reads stdin), `--download-dir`, `--media-dir`,
  `--vpn-provider`, `--vpn-location`, `--install-docker`, `--json`, and `llm-install`
  (`--format md|json`, `--write`). `supplied_answers` loads env → file → flags once, before
  the root and Docker checks, so an incomplete set exits 2 without touching the host.
  `ask_questions` is untouched; the resolver replaces it on the scripted path. Every
  remaining `confirm()` (install, create dir, Docker, uninstall, migrate, update) is gated
  on `args.non_interactive()` / `args.yes`. Jellyfin admin takes the file first, then the
  environment, then an existing `.env`, and otherwise generates a 24-character password
  written to `server/.env` with mode 600 and never printed.
- `src/llm.rs` — prompt builder from live data, plus JSON form.
- `tests/noninteractive.rs` — 10 integration tests including the no-TTY binary exiting 2.
- `README.md` "Non-interactive installs", new `docs/src/automation.md`, introduction link.

Verified: `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test`
(183 tests) all green.

## Decisions taken

- Answers file is `.env` syntax, not TOML/JSON: zero new deps, same keys as `.env`, and
  reuses `envfile::parse`.
- No trait abstraction over prompts; one short-circuit in `ask_questions` keeps the
  interactive path byte-identical and reviewable.
- Docker is never installed implicitly: `--install-docker` is the explicit opt-in.
- Generated Jellyfin password is persisted rather than echoed, so it does not land in a
  transcript.

## Open questions

- Should `llm-install` also *run* an agent (e.g. `--exec claude`), or stay a pure prompt
  dump? Plan assumes prompt-only.
- Is `churn update --non-interactive` in scope, or install-only for now? Plan assumes
  install/uninstall/migrate only need `--yes` (they already have it).


## Live test: llm-install on this host (2026-11-10)

Ran `sudo cargo run -- llm-install` (prompt printed, nothing written), followed the
prompt by hand, and installed both stacks on the dev box. Install succeeded:
`server` + `torrent` up, `verify-vpn` green, Jellyfin wizard completed with the
supplied admin, library `Media` at `/data/jellyfin` scanned 12 movies / 2 series /
42 episodes, vpn-status `secure: true` (mullvad, exit 193.32.249.224, kill
switch + DNS + IPv6 all true). Answers file removed afterwards.

### Bugs found by the live run

- `--dry-run` still creates directories. `ensure_directories` is called at
  `src/main.rs:2855` before any `args.dry_run` check, `and create_if_missing`
  takes no dry-run flag, so `--dry-run` created `/data/downloads` (and would
  create `MEDIA_DIR` + `movies`/`tv`) while the outro prints
  "dry run complete — no files written". `churn-qeq8` regression risk: the
  `--json` contract advertises `"dry_run":true` as side-effect free.
- `torrent/.env` keeps mode 0644 while holding `WIREGUARD_PRIVATE_KEY`
  (observed: `-rw-r--r-- root root 584`). Only `server/.env` is chmod 0600, and
  only because `scripted_jellyfin_credentials` (`src/main.rs:1394`) does it
  after `stack.apply`. VPN credentials are readable by every local user.
- The prompt tells the agent to write `./churn-answers.env`, but `.gitignore`
  only ignores `.env` (exact name), so that filename is untracked-but-stageable:
  `git check-ignore churn-answers.env` fails. An agent following the prompt
  verbatim in a repo can commit the VPN key.
- Prompt drift: it says `VPN_LOCATION` is optional and "Gluetun chooses a server
  itself", but the resolver fills in the provider's `default_location`
  (`Netherlands` here) and writes `SERVER_COUNTRIES=Netherlands`. Either the
  prompt should say churn pins the default country, or the resolver should leave
  it empty.
- Minor: the prompt's `--answers` guidance never mentions that the file must be
  mode 0600 *and that chmod after `umask` is needed* — worth an explicit line
  since `tee`/redirection normally yields 0644 and churn exits 2.

### Notes for the install path itself

- `/data/media` still has a stale `.churn-migrate.json` from an unfinished
  `churn migrate` on 2026-11-07; the install adopted `/data/jellyfin` instead, so
  that marker is untouched (and `churn migrate` will resume into it if run).
- `PUID`/`PGID` resolved to 0 because `/data/jellyfin` is root-owned; the
  `storage_warning` is suppressed under root, so nothing flagged it.


## Live test: llm-install on this host (2026-11-10)

Ran `sudo cargo run -- llm-install` (prompt printed, nothing written), followed the
prompt by hand, and installed both stacks on the dev box. Install succeeded:
`server` + `torrent` up, `verify-vpn` green, Jellyfin wizard completed with the
supplied admin, library `Media` at `/data/jellyfin` scanned 12 movies / 2 series /
42 episodes, vpn-status `secure: true` (mullvad, exit 193.32.249.224, kill
switch + DNS + IPv6 all true). Answers file removed afterwards.

### Bugs found by the live run

- `--dry-run` still creates directories. `ensure_directories` is called at
  `src/main.rs:2855` before any `args.dry_run` check, `and create_if_missing`
  takes no dry-run flag, so `--dry-run` created `/data/downloads` (and would
  create `MEDIA_DIR` + `movies`/`tv`) while the outro prints
  "dry run complete — no files written". `churn-qeq8` regression risk: the
  `--json` contract advertises `"dry_run":true` as side-effect free.
- `torrent/.env` keeps mode 0644 while holding `WIREGUARD_PRIVATE_KEY`
  (observed: `-rw-r--r-- root root 584`). Only `server/.env` is chmod 0600, and
  only because `scripted_jellyfin_credentials` (`src/main.rs:1394`) does it
  after `stack.apply`. VPN credentials are readable by every local user.
- The prompt tells the agent to write `./churn-answers.env`, but `.gitignore`
  only ignores `.env` (exact name), so that filename is untracked-but-stageable:
  `git check-ignore churn-answers.env` fails. An agent following the prompt
  verbatim in a repo can commit the VPN key.
- Prompt drift: it says `VPN_LOCATION` is optional and "Gluetun chooses a server
  itself", but the resolver fills in the provider's `default_location`
  (`Netherlands` here) and writes `SERVER_COUNTRIES=Netherlands`. Either the
  prompt should say churn pins the default country, or the resolver should leave
  it empty.
- Minor: the prompt's `--answers` guidance never mentions that the file must be
  mode 0600 *and that chmod after `umask` is needed* — worth an explicit line
  since `tee`/redirection normally yields 0644 and churn exits 2.

### Notes for the install path itself

- `/data/media` still has a stale `.churn-migrate.json` from an unfinished
  `churn migrate` on 2026-11-07; the install adopted `/data/jellyfin` instead, so
  that marker is untouched (and `churn migrate` will resume into it if run).
- `PUID`/`PGID` resolved to 0 because `/data/jellyfin` is root-owned; the
  `storage_warning` is suppressed under root, so nothing flagged it.

### Fixes applied (uncommitted, for review)

1. `--dry-run` no longer writes: `ensure_directories(answers, assume_yes, dry_run)`
   / `create_if_missing(path, assume_yes, dry_run)` in `src/main.rs` now log
   `would create <path>` and return before `create_dir_all`; call site at
   `src/main.rs:2855` passes `args.dry_run`. Regression test
   `a_dry_run_writes_no_directories` in `tests/noninteractive.rs`.
2. `envfile::write_merged_dropping` now calls a new `envfile::restrict(path)`
   (chmod 0600) after writing, so a freshly created `torrent/.env` no longer
   inherits 0644 with the WireGuard key in it. `scripted_jellyfin_credentials`
   uses the same helper. Test `a_written_env_file_is_owner_only`. Verified live:
   rerun now leaves both `.env` at `-rw-------`.
3. `.gitignore` now ignores `churn-answers.env` and `.churn-answers.env`.
4. Prompt corrected in `src/llm.rs`: `VPN_LOCATION` absence is documented as
   "churn writes the provider's default and pins the containers to it" (not
   "Gluetun chooses"), the plan bullet asks for the resolved location + exit IP,
   and the secrets rule now spells out `umask 077` / `install -m 600`, the 0644
   inherited from a redirect, and the repo-commit risk.
5. README: new note at the end of the Install section pointing at
   `churn llm-install` as the "install churn for me" path; Non-interactive
   section documents the 0600 answers file, the redirect pitfall, and that the
   stack `.env` files are 0600. `docs/src/automation.md` carries the same.
