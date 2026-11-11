# Non-interactive installs

`churn` is normally a wizard. `--non-interactive` runs the identical install
without opening a single prompt, which makes it usable from a script, a
configuration-management run, or an LLM — and it is the same code path, so the
answers, validation and safety checks are not a second implementation.

## What still gets asked

Nothing. Every answer comes from, in order of precedence:

1. a command-line flag (`--download-dir`, `--media-dir`, `--vpn-provider`,
   `--vpn-location`);
2. the `--answers <path>` file, or `--answers -` for stdin;
3. the environment (`DOWNLOAD_DIR`, `MEDIA_DIR`, `VPN_SERVICE_PROVIDER`,
   `WIREGUARD_PRIVATE_KEY`, `OPENVPN_USER`, and the other keys from the table in
   the prompt);
4. the `.env` file of an existing installation, so a rerun repairs in place.

Anything the installer can decide sensibly, it decides and logs instead of
asking:

- **Ports.** The port a previous run chose is kept; otherwise the conventional
  port is used when it is free, and the nearest free port when it is not.
- **Exit location.** The provider's default location is used when
  `VPN_LOCATION` is absent.
- **Storage paths.** Directories are created, including `movies/` and `tv/`
  under `MEDIA_DIR`, rather than prompting for each. `--dry-run` reports
  `would create` and creates nothing — a rehearsal leaves the disk untouched.
- **Jellyfin admin.** A 24-character password is generated and written with
  `JELLYFIN_ADMIN_USER`/`JELLYFIN_ADMIN_PASSWORD` to `server/.env` (mode 600)
  unless the answers supply the password. It is never echoed.

## Failure mode

The answer set is resolved *before* the root and Docker checks and before
anything is written. An incomplete or invalid set exits with status 2 and names
only the keys that are missing or wrong:

```
churn: non-interactive install is still missing: DOWNLOAD_DIR, MEDIA_DIR
Supply them with a flag, --answers <file>, the environment, or an existing .env.
```

A wired-in guard test asserts that the resolver answers every question
`Stack::collect_questions` can produce, so a new question cannot quietly be
added without a non-interactive default.

The answers file holds secrets, so it must not be readable by other users.
churn refuses anything looser than `0600` and tells the caller to `chmod 600`
it; use `--answers -` if the file should never touch the disk. A redirect or
`tee` creates the file `0644`, so set the mode explicitly (`umask 077`, or
`install -m 600 /dev/null <path>`) before writing it. Keep it out of the
repository as well: `churn-answers.env` is in `.gitignore`, but an untracked
file is one `git add -A` away.

The stack `.env` files written by an install are `0600` for the same reason:
`torrent/.env` holds the WireGuard private key and `server/.env` the Jellyfin
admin password.

## Secrets

`argv` is visible in `ps` and shell history, so secrets are never accepted as
flags. The answers file (or the environment, or an existing `.env`) is the only
route, and the LLM prompt says so explicitly.

## `churn llm-install`

`churn llm-install` prints a prompt for an agent that is about to drive an
install:

```bash
churn llm-install --stacks server,torrent          # markdown
churn llm-install --format json                    # one JSON object
churn llm-install --write ./churn-prompt.md        # to a file
```

It is read-only: no root, no Docker, nothing written unless `--write` is given.
The prompt is built from the same tables the installer enforces — the provider
ids, which credentials each provider requires, the location filters, the answer
keys, the real `--help` text and the binary's own version — so it cannot drift
away from the code.

Its instructions are the behaviour the user asked for:

- **Discover, don't ask.** Read `df -hT`, `lsblk`, `findmnt`, `churn show
  --json`, any existing `/var/lib/churn/*/.env`, and a running Jellyfin's
  `/System/Info/Public` before asking the person anything.
- **Choose the storage layout, then confirm it.** Pick a sensible default from
  the discovered disks, present the trade-off (which disk, how much is free,
  why), and get agreement before writing it down. An existing Jellyfin library
  is adopted in place rather than moved.
- **Gather everything before installing.** Data locations, whether an existing
  media library is reused, VPN provider and credentials, Jellyfin admin
  details — all of it, then a single install.
- **Confirm the plan.** The whole plan is shown in one message and the install
  does not run until the user says yes. `--non-interactive` implies `-y`, so
  that conversation is the only confirmation there is.
- Do not touch ports, do not put secrets in `argv`, do not destroy data to
  recover from a failure, then verify with `churn verify-vpn`.
