//! `churn llm-install`: a prompt that teaches an LLM to do the install.
//!
//! The text is assembled from live data — the provider list, the env keys, the
//! port defaults, the real `--help` — so it cannot drift from the installer the
//! way a hand-written document would. It is also completely side-effect free: it
//! writes no files and starts no containers, so it is safe to print on any host,
//! including one where churn is not installed yet.

use crate::question::Question;
use crate::stack::Stack;
use crate::vpn::VpnProvider;

/// Build the markdown prompt for `--stacks <chosen>`.
pub fn markdown(stacks: &[Stack], version: &str, help: &str) -> String {
    let stacks = if stacks.is_empty() {
        Stack::ALL.to_vec()
    } else {
        crate::stack::start_order(stacks.to_vec())
    };
    let stack_list = stacks
        .iter()
        .map(|stack| stack.key())
        .collect::<Vec<_>>()
        .join(",");

    let mut prompt = String::with_capacity(16 * 1024);
    prompt.push_str(&format!(
        "# Install churn on this machine, non-interactively\n\n\
         You are installing **churn {version}**, a Docker installer for a media/torrent\n\
         stack (Jellyfin + Sonarr + Radarr + Prowlarr, plus qBittorrent behind a VPN).\n\
         churn has a `--non-interactive` mode that never opens a prompt, so it runs\n\
         from a shell you control. Your job is to gather the answers it needs from the\n\
         person you are talking to, confirm the plan with them, then run it.\n\n\
         ## Hard rules\n\n\
         1. **Never invent credentials.** The VPN credentials and the Jellyfin admin\n\
            password must come from the user. If they are not available, ask.\n\
         2. **Never put secrets on the command line.** Anything in `argv` is visible in\n\
            `ps` and in shell history. Write secrets to an answers file with mode 600 and\n\
            pass `--answers <path>`. Never echo a secret back into the conversation, and\n\
            never print the answers file. A shell redirect creates the file 0644, so set\n\
            the mode explicitly (`umask 077` before writing, or `install -m 600 /dev/null\n\
            <path>` first) — churn refuses a looser file and exits 2. Keep the file out of\n\
            the repository: `churn-answers.env` is in `.gitignore`, but an untracked file\n\
            is still one `git add -A` away.\n\
         3. **Do not choose ports.** churn picks the conventional port when it is free and\n\
            the nearest free one when it is not. Report what it chose afterwards; do not\n\
            pass `*_PORT` answers unless the user explicitly asks for a specific port.\n\
         4. **Confirm before you install.** Do not run the install until the user has seen\n\
            the full plan (see *Confirm the plan*) and said yes. `--non-interactive`\n\
            implies `-y`, so this conversation is the only confirmation there is.\n\
         5. **Never destroy data to recover from a failure.** If the install fails, report\n\
            the error. Do not delete `/var/lib/churn`, the media library, downloads, or the\n\
            `.env` files. A rerun is safe; a wipe is not.\n\
         6. **Run as root.** churn needs root to install Docker and write `/var/lib/churn`.\n\
            If you are not root, ask the user to run `sudo churn ...` themselves rather\n\
            than escalating on your own.\n\n"
    ));

    prompt.push_str(&format!(
        "## The exact command you will run\n\n\
         ```sh\n\
         sudo churn --stacks {stack_list} --non-interactive --answers ./churn-answers.env\n\
         ```\n\n\
         Add `--dry-run` for a rehearsal (writes nothing, starts nothing) and\n\
         `--json` to get one JSON object back instead of human text.\n\n\
         ### Answer keys\n\n\
         `--answers` is `.env` syntax and takes these keys:\n\n\
         | key | meaning |\n\
         | --- | --- |\n"
    ));
    for (key, meaning) in answer_keys() {
        prompt.push_str(&format!("| `{key}` | {meaning} |\n"));
    }
    prompt.push_str(
        "\nEvery key can also come from the environment instead of the file, which is\n\
         slightly safer if the file would outlive the install. Flags win over the file,\n\
         and the file wins over the environment.\n\n",
    );

    prompt.push_str(
        "## Step 1 — Discover, don't ask\n\n\
         Learn what you can from the machine before asking the person anything. Every\n\
         question you can answer yourself is a question they do not have to.\n\n\
         Run these and read the output:\n\n\
         ```sh\n\
         # Disks: where is there space, which filesystem, is it a network mount?\n\
         df -hT\n\
         lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,ROTA,TRAN\n\
         findmnt -t nfs,nfs4,cifs,smb3,sshfs   # anything here is a bad home for SQLite\n\n\
         # Is churn, or any of this stack, already installed?\n\
         sudo churn show --json\n\
         ls -la /var/lib/churn /var/lib/churn/server/.env /var/lib/churn/torrent/.env\n\
\n\
         # Is there an existing Jellyfin? (its config names the library it indexes)\n\
         curl -s http://127.0.0.1:8096/System/Info/Public\n\
         docker ps --format '{{.Names}}\\t{{.Image}}\\t{{.Ports}}'\n\
\n\
         # An existing library, if there is one\n\
         ls -d /srv/*/movies /srv/*/tv /mnt/*/*/movies /media/*/tv 2>/dev/null\n\
         ```\n\n\
         What you are looking for:\n\n\
         - **Disk space.** Downloads grow fast and Jellyfin transcodes: the download\n\
           directory must be on a fast local disk, and the media directory on the disk\n\
           with the most room.\n\
         - **An existing library.** If Jellyfin is already running with libraries\n\
           configured, that is the media directory to use — see *Adopt, don't move*.\n\
         - **An existing churn install.** If `churn show --json` returns services, this\n\
           is a rerun or a repair. Read the existing `.env` first and keep the answers it\n\
           already holds; do not re-ask for what is configured.\n\
         - **Docker.** If `docker compose version` fails, the install will stop and tell\n\
           you so. Only pass `--install-docker` if the user agrees to churn installing\n\
           Docker for them.\n\n\
         ## Step 2 — Gather everything before you install\n\n\
         Do not start the install with any of these missing. A missing answer means exit\n\
         code 2 and nothing written, so collecting them piecemeal just wastes a round trip.\n\n\
         - [ ] Download directory on a local, fast, roomy disk\n\
         - [ ] Media directory, and whether it is a new library or an existing one in\n\
               place\n\
         - [ ] Which stacks: `server` (Jellyfin/Sonarr/Radarr/dashboard), `torrent`\n\
               (qBittorrent/Prowlarr/Gluetun) or both. Both on one machine is normal\n\
         - [ ] VPN provider, its credentials, and a location the user is happy with\n\
         - [ ] Jellyfin admin username and password — or the user's agreement that churn\n\
               generates a password and saves it to `server/.env`\n\n\
         ## Step 3 — Choose the storage layout, then confirm it\n\n\
         Pick a sensible default from what you discovered, then **confirm it with the\n\
         user** before it goes into the answers file. Present the trade-off, not just a\n\
         path: which disk, how much is free, and why it is the right one.\n\n\
         - `DOWNLOAD_DIR` — in-progress downloads. Must be a local filesystem: qBittorrent\n\
           writes constantly, and network filesystems corrupt its state. Prefer the disk\n\
           with the fastest write speed that has room for work in progress.\n\
         - `MEDIA_DIR` — the finished library Jellyfin indexes. Prefer the largest local\n\
           disk, or a network mount only if the user accepts slower scans.\n\
         - `MEDIA_DIR` may live inside `DOWNLOAD_DIR` (the default layout is\n\
           `<download>/media`) but the two may not be the *same* path, and `MEDIA_DIR`\n\
           may not contain `DOWNLOAD_DIR`.\n\n\
         ### Adopt, don't move\n\n\
         If a Jellyfin library already exists, use its path as `MEDIA_DIR` rather than\n\
         creating a new directory. churn mounts that path into the containers; the files\n\
         stay where they are and the existing library keeps working. Tell the user you are\n\
         reusing the library in place, and let Jellyfin rescan it after the install.\n\n\
         churn creates the directories it needs and the `movies`/`tv` subdirectories under\n\
         `MEDIA_DIR`. Those steps do not prompt in non-interactive mode; they are logged.\n\n\
         Do not pass any `*_PORT` answer. Ports are churn's job.\n\n",
    );

    prompt.push_str(
        "## Step 4 — The VPN\n\n\
         Gluetun is the only way out for the torrent stack; every torrent service shares\n\
         its network namespace. Ask the user which provider they use, then collect exactly\n\
         the credentials that provider needs.\n\n\
         | `VPN_SERVICE_PROVIDER` | provider | protocol | credentials | location filter |\n\
         | --- | --- | --- | --- | --- |\n",
    );
    for provider in VpnProvider::ALL {
        let credentials = provider
            .required_env()
            .iter()
            .map(|key| format!("`{key}`"))
            .collect::<Vec<_>>()
            .join(", ");
        prompt.push_str(&format!(
            "| `{}` | {} | {} | {} | {} ({} known, e.g. `{}`) |\n",
            provider.gluetun_id(),
            provider.label(),
            provider.protocol().label(),
            credentials,
            provider.location_key(),
            provider.locations().len(),
            provider.default_location().unwrap_or("(provider default)"),
        ));
    }
    prompt.push_str(
        "\n`VPN_LOCATION` is optional, but churn does not leave the choice to Gluetun: when\n\
         the key is absent it writes the provider's default location (the one in the\n\
         `location filter` column) as both `VPN_LOCATION` and the provider's own key, and\n\
         the containers start pinned to that country. If the user names a country, use\n\
         the provider's own spelling — the answers file is validated against the embedded\n\
         list, and a wrong spelling is rejected with the closest match. Say which country\n\
         will be used when you present the plan.\n\n\
         WireGuard keys are base64 and 32 bytes when decoded; a key that is not is\n\
         rejected. `WIREGUARD_ADDRESSES` is the interface address from the provider's\n\
         WireGuard config, in CIDR form such as `10.64.0.2/32`. Some providers (Mullvad,\n\
         IVPN, Surfshark) need both; ProtonVPN and NordVPN need only the key; Private\n\
         Internet Access uses OpenVPN and needs `OPENVPN_USER` and `OPENVPN_PASSWORD`\n\
         instead.\n\n\
         If the user does not have a provider yet, stop and let them choose one. Do not\n\
         guess credentials, and do not install the torrent stack without them: qBittorrent\n\
         without a tunnel is exactly the failure this stack exists to prevent.\n\n",
    );

    prompt.push_str(
        "## Step 5 — The Jellyfin admin account\n\n\
         Two options, both fine:\n\n\
         - Put `JELLYFIN_ADMIN_USER` and `JELLYFIN_ADMIN_PASSWORD` in the answers file.\n\
           The password must be at least 8 characters.\n\
         - Leave them out. churn generates a 24-character password, uses it for the admin\n\
           account, and writes both values to `server/.env` as `root:PGID` mode 640. The\n\
           password is never echoed to stdout.\n\n\
         Either way, tell the user afterwards where the password lives: `JELLYFIN_ADMIN_*`\n\
         in `/var/lib/churn/server/.env`. Never print the value.\n\n\
         ## Step 6 — Confirm the plan\n\n\
         This is the step that makes the install safe. Present the whole plan in one\n\
         message and get an explicit yes before running anything:\n\n\
         - the stacks being installed, in one sentence each\n\
         - `DOWNLOAD_DIR` and `MEDIA_DIR`, with which disk each is on\n\
         - whether an existing library is being adopted in place\n\
         - VPN provider, protocol and exit location (the provider's default when the\n           user does not name one) and the exit IP once `verify-vpn` reports it\n\
         - that ports are chosen automatically, and which ones the install will use if\n\
           you already know them (`--dry-run` shows the resolved plan)\n\
         - the Jellyfin admin user, and that its password will be in `server/.env`\n\
         - where secrets are written (the answers file, mode 600 — and that you will\n\
           remove it or the user should, once the install succeeded)\n\
         - what happens next: Docker starting containers, Jellyfin's first-run wizard,\n\
           and that a VPN health check runs at the end\n\n\
         If the user changes anything, update the answers file and show the plan again.\n\n\
         ## Step 7 — Run it, then verify\n\n\
         ```sh\n\
         sudo churn --stacks ",
    );
    prompt.push_str(&stack_list);
    prompt.push_str(
        " --non-interactive --answers ./churn-answers.env --json\n\
         sudo churn show --json        # the URLs that are now live\n\
         sudo churn verify-vpn         # torrent stack only: prove the kill switch holds\n\
         ```\n\n\
         `verify-vpn` reads the rendered compose config and fails if any networked service\n\
         could leave the tunnel. Report its result. Do not report the install as successful\n\
         until it passes.\n\n\
         After success, delete the answers file (`rm ./churn-answers.env`) — the values\n\
         churn needs are already in the stack `.env` files — and tell the user their\n\
         service URLs from `show --json`.\n\n\
         ## Exit codes\n\n\
         | code | meaning | what to do |\n\
         | --- | --- | --- |\n\
         | 0 | success | report URLs, then `verify-vpn` |\n\
         | 1 | a step failed | read the error, fix the cause, rerun the same command |\n\
         | 2 | answers missing or invalid | the message names the keys; collect only those, rerun |\n\
         | 130 | cancelled by the user | stop; nothing was written |\n\n\
         A rerun is idempotent: existing `.env` values are reused, ports already in use by\n\
         this installation are kept, and only what changed is written. You do not need to\n\
         uninstall to fix a partial install.\n\n\
         ## What churn writes\n\n\
         `DOWNLOAD_DIR` and `MEDIA_DIR` (created if missing, with `movies`/`tv` under the\n\
         media path), the stack files and `.env` files under `/var/lib/churn` (or\n\
         `CHURN_ROOT`), Docker containers and volumes for the dashboard, and\n\
         `JELLYFIN_API_KEY` plus the admin pair in `server/.env` after Jellyfin's setup.\n\
         Media and downloads are never deleted by an install.\n\n\
         ## Reference: churn's own help\n\n\
         ```\n",
    );
    prompt.push_str(help.trim_end());
    prompt.push_str("\n```\n");
    prompt
}

/// The keys an answers file accepts, in the order the prompt lists them.
fn answer_keys() -> Vec<(&'static str, &'static str)> {
    let mut keys = vec![
        ("DOWNLOAD_DIR", "where in-progress downloads live"),
        ("MEDIA_DIR", "the library Jellyfin indexes"),
        (
            "VPN_SERVICE_PROVIDER",
            "the provider id from the table below",
        ),
        (
            "VPN_LOCATION",
            "optional country/region, in the provider's spelling",
        ),
    ];
    // Credentials are per protocol, so list the union with the provider noted.
    keys.push((
        "WIREGUARD_PRIVATE_KEY",
        "WireGuard private key (base64, 32 bytes) — Mullvad, IVPN, ProtonVPN, NordVPN, Surfshark",
    ));
    keys.push((
        "WIREGUARD_ADDRESSES",
        "WireGuard interface address, CIDR — Mullvad, IVPN, Surfshark",
    ));
    keys.push(("OPENVPN_USER", "OpenVPN username — Private Internet Access"));
    keys.push((
        "OPENVPN_PASSWORD",
        "OpenVPN password — Private Internet Access",
    ));
    keys.push((
        "JELLYFIN_ADMIN_USER",
        "Jellyfin admin username (default `admin`)",
    ));
    keys.push((
        "JELLYFIN_ADMIN_PASSWORD",
        "Jellyfin admin password (≥8 chars); omit to have churn generate one",
    ));
    // Ports are supported by the answers file but deliberately absent here:
    // churn chooses them, and suggesting them invites an agent to hard-code one.
    keys
}

/// The same prompt as one JSON object, for a caller that wants to hand a text
/// blob to a model without parsing markdown boundaries.
pub fn json(prompt: &str) -> String {
    format!(
        "{{\"command\":\"llm-install\",\"prompt\":{}}}",
        json_string(prompt)
    )
}

/// Minimal JSON string escaping. The installer deliberately has no serde
/// dependency for output, and every string it emits goes through here.
pub fn json_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Keys a non-interactive install will ask for, for the tests and the README.
pub fn required_keys() -> Vec<&'static str> {
    Question::ALL
        .iter()
        .map(|question| question.env_key())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::Port;

    fn built() -> String {
        markdown(&[Stack::Server, Stack::Torrent], "9.9.9", "USAGE: churn")
    }

    #[test]
    fn every_provider_is_documented_with_its_credentials() {
        let prompt = built();
        for provider in VpnProvider::ALL {
            assert!(
                prompt.contains(&format!("`{}`", provider.gluetun_id())),
                "{} is missing from the provider table",
                provider.gluetun_id()
            );
            for key in provider.required_env() {
                assert!(
                    prompt.contains(&format!("`{key}`")),
                    "{key} for {} is missing",
                    provider.gluetun_id()
                );
            }
        }
    }

    #[test]
    fn the_prompt_explains_the_install_contract() {
        let prompt = built();
        for expected in [
            "--non-interactive",
            "--answers",
            "--dry-run",
            "--json",
            "churn verify-vpn",
            "Exit codes",
            "exit\ncode 2",
            "Discover, don't ask",
            "Adopt, don't move",
            "Confirm the plan",
            "Gather everything before you install",
            "Never destroy data",
        ] {
            assert!(
                prompt.contains(expected),
                "the prompt must mention {expected:?}"
            );
        }
    }

    #[test]
    fn the_prompt_never_tells_the_agent_to_choose_ports() {
        let prompt = built();
        // Ports are churn's job; naming a default would invite the agent to set it.
        for port in Port::ALL {
            assert!(
                !prompt.contains(&format!("{}={}", port.env_key(), port.default_port())),
                "{} must not come with a suggested value",
                port.env_key()
            );
            assert!(
                !prompt.contains(&format!("--{} ", port.env_key().to_ascii_lowercase())),
                "{} must not look like a flag to pass",
                port.env_key()
            );
        }
        assert!(prompt.contains("Do not choose ports"));
    }

    #[test]
    fn the_prompt_embeds_the_real_help_text() {
        let prompt = markdown(&[Stack::Torrent], "9.9.9", "USAGE: churn --test-marker");
        assert!(prompt.contains("--test-marker"));
        assert!(prompt.contains("--stacks torrent "));
    }

    #[test]
    fn the_json_form_is_a_single_valid_object() {
        let prompt = markdown(&[], "9.9.9", "help");
        let document = json(&prompt);
        assert!(document.starts_with("{\"command\":\"llm-install\",\"prompt\":\""));
        assert!(document.ends_with("\"}"));
        // The prompt contains newlines and quotes; both must be escaped.
        assert!(document.contains("\\n"));
        assert!(!document.contains('\n'));
        assert_eq!(document.matches('"').count() % 2, 0);
    }

    #[test]
    fn an_empty_stack_selection_documents_both_stacks() {
        let prompt = markdown(&[], "9.9.9", "help");
        assert!(prompt.contains("--stacks server,torrent "));
    }

    #[test]
    fn the_answers_table_covers_every_key_the_resolver_reads() {
        let prompt = built();
        for key in answer_keys() {
            assert!(
                prompt.contains(&format!("| `{}` |", key.0)),
                "{} is missing from the answer key table",
                key.0
            );
        }
        assert!(!answer_keys().iter().any(|(key, _)| key.ends_with("_PORT")));
    }
}
