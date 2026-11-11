//! Resolving installer answers without a terminal.
//!
//! `--non-interactive` never constructs a cliclack prompt. Everything the wizard
//! would have asked is resolved here from three sources, in this order:
//!
//! 1. a value supplied by the caller (a flag, the `--answers` file, or the
//!    environment — `main` merges all three into one map),
//! 2. the value a previous run wrote to the stack `.env`,
//! 3. the built-in default.
//!
//! The resolver is pure: no prompts, no `cliclack`. Every value is validated
//! with the same functions the interactive prompts use, so a scripted install
//! accepts exactly what a human typing the same answers would.

use std::collections::HashMap;
use std::fmt;

use crate::ports::{self, Port};
use crate::question::{self, Question};
use crate::stack::{Answers, FALLBACK_VPN_LOCATION};
use crate::vpn::VpnProvider;

/// Why a non-interactive install cannot proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unresolved {
    /// Answers the caller has to supply, named by `.env` key so the message is
    /// actionable: `non-interactive install is still missing: MEDIA_DIR`.
    Missing(Vec<&'static str>),
    /// A supplied answer is not usable (bad provider, bad key, port clash).
    Invalid(String),
}

impl Unresolved {
    pub fn message(&self) -> String {
        match self {
            Unresolved::Missing(keys) => format!(
                "non-interactive install is still missing: {}\n\
                 Supply them with a flag, --answers <file>, the environment, or an existing .env.",
                keys.join(", ")
            ),
            Unresolved::Invalid(reason) => reason.clone(),
        }
    }

    /// The keys that are missing, if that is what went wrong.
    pub fn missing(&self) -> &[&'static str] {
        match self {
            Unresolved::Missing(keys) => keys,
            Unresolved::Invalid(_) => &[],
        }
    }
}

impl fmt::Display for Unresolved {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for Unresolved {}

/// Resolve every answer the chosen stacks need.
///
/// `stored` is the merged `Answers` of the installed stacks (rerun reuse);
/// `supplied` is keyed by `.env` key so the caller can pass the `--answers`
/// file, flags and environment through without translating them first.
pub fn resolve(
    stored: &Answers,
    supplied: &HashMap<String, String>,
) -> Result<Answers, Unresolved> {
    let stored_value = |question: Question| {
        stored
            .get(&question)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let mut answers = Answers::new();
    let mut missing: Vec<&'static str> = Vec::new();

    // The provider goes first: it decides which credential keys are required.
    let provider = match supplied_value(supplied, Question::VpnProvider) {
        Some(value) => VpnProvider::from_gluetun_id(&value)
            .ok_or_else(|| Unresolved::Invalid(unknown_provider(&value)))?,
        None => Question::provider_from(stored_value(Question::VpnProvider).as_deref()),
    };
    answers.insert(Question::VpnProvider, provider.gluetun_id().to_string());

    // Storage: deliberately no default. Which disks hold the library and the
    // in-progress downloads is the one thing only the host (or the person in
    // front of it) knows, and a guess here starts containers that cannot see
    // the media.
    for question in [Question::DownloadDir, Question::MediaDir] {
        match supplied_value(supplied, question).or_else(|| stored_value(question)) {
            Some(value) => {
                let path = question::normalize_path(&value);
                question::validate_data_dir(&path).map_err(Unresolved::Invalid)?;
                answers.insert(question, path);
            }
            None => missing.push(question.env_key()),
        }
    }

    // Credentials for the protocol this provider actually uses. The other
    // protocol's key is ignored even when it is supplied, so switching provider
    // in an answers file cannot smuggle in a credential Gluetun never reads.
    for key in provider.required_env() {
        let Some(question) = Question::from_env_key(key) else {
            continue;
        };
        match supplied_value(supplied, question).or_else(|| stored_value(question)) {
            Some(value) => {
                validate_credential(question, &value).map_err(Unresolved::Invalid)?;
                answers.insert(question, value);
            }
            None => missing.push(key),
        }
    }

    // Location: a supplied value must be in the provider's embedded list, a
    // stored one is replaced when the provider changed, and the provider
    // default is the fallback — Gluetun picks a server itself for an empty
    // filter, so an unset location is never an error.
    let location = match supplied_value(supplied, Question::VpnLocation) {
        Some(value) => {
            // A scripted answer may differ only in case ("netherlands"); write
            // the provider's spelling instead of failing on a cosmetic mismatch.
            let canonical = canonical_location(provider, &value);
            provider
                .validate_location(&canonical)
                .map_err(Unresolved::Invalid)?;
            canonical
        }
        None => stored_value(Question::VpnLocation)
            .filter(|value| provider.validate_location(value).is_ok())
            .map(|value| canonical_location(provider, &value))
            .unwrap_or_else(|| {
                provider
                    .default_location()
                    .unwrap_or(FALLBACK_VPN_LOCATION)
                    .to_string()
            }),
    };
    answers.insert(Question::VpnLocation, location);

    // Ports are never asked for. An explicit or stored port is kept; otherwise
    // the conventional port is used when it is free and the nearest free one
    // when it is not — the same choice `resolve_port` makes after its prompt.
    let mut taken: Vec<u16> = Vec::new();
    for port in Port::ALL {
        let question = Question::Port(port);
        let chosen = match supplied_value(supplied, question) {
            Some(value) => {
                let number = ports::validate_port(&value).map_err(Unresolved::Invalid)?;
                if taken.contains(&number) {
                    return Err(Unresolved::Invalid(format!(
                        "port {number} is assigned to more than one service; give each service its own port"
                    )));
                }
                number
            }
            None => match stored_value(question)
                .and_then(|value| ports::validate_port(&value).ok())
                .filter(|number| !taken.contains(number))
            {
                Some(number) => number,
                None => nearest_free_port(port, &taken),
            },
        };
        taken.push(chosen);
        answers.insert(question, chosen.to_string());
    }

    if !missing.is_empty() {
        // Report in question order so the message is stable across runs.
        let ordered: Vec<&'static str> = Question::ALL
            .iter()
            .map(|question| question.env_key())
            .filter(|key| missing.contains(key))
            .collect();
        return Err(Unresolved::Missing(ordered));
    }

    // The storage pair is only checkable once both halves are known.
    if let (Some(download), Some(media)) = (
        answers.get(&Question::DownloadDir),
        answers.get(&Question::MediaDir),
    ) {
        question::validate_storage_paths(download, media).map_err(Unresolved::Invalid)?;
    }
    Ok(answers)
}

/// Read one supplied value, treating blanks as absent so an empty `MEDIA_DIR=`
/// line in an answers file is reported instead of written.
fn supplied_value(supplied: &HashMap<String, String>, question: Question) -> Option<String> {
    supplied
        .get(question.env_key())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Port for `port` that neither another churn service nor a listener owns.
fn nearest_free_port(port: Port, taken: &[u16]) -> u16 {
    let default = port.default_port();
    if !taken.contains(&default) && port.is_free(default) {
        return default;
    }
    // Keep away from every other default, even if that service has not been
    // processed yet and may itself move later.
    let mut reserved = taken.to_vec();
    reserved.extend(
        Port::ALL
            .iter()
            .filter(|other| **other != port)
            .map(|other| other.default_port()),
    );
    ports::nearest_free(default, &reserved, port)
}

/// The provider's own spelling, so `netherlands` is written as `Netherlands`
/// and `US Seattle` keeps its PIA capitalisation.
fn canonical_location(provider: VpnProvider, value: &str) -> String {
    let value = value.trim();
    provider
        .locations()
        .iter()
        .find(|known| known.eq_ignore_ascii_case(value))
        .map(|known| known.to_string())
        .unwrap_or_else(|| value.to_string())
}

fn validate_credential(question: Question, value: &str) -> Result<(), String> {
    match question {
        Question::WireguardPrivateKey => question::validate_wireguard_key(value),
        Question::WireguardAddresses => question::validate_wireguard_address(value),
        Question::OpenvpnUser | Question::OpenvpnPassword => {
            if value.trim().is_empty() {
                Err(format!("{} is required.", question.label()))
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn unknown_provider(value: &str) -> String {
    format!(
        "unknown VPN provider {value:?} — expected one of: {}",
        VpnProvider::ALL
            .map(|provider| provider.gluetun_id())
            .join(", ")
    )
}

/// Generate a Jellyfin admin password for a non-interactive install.
///
/// 24 characters from an alphabet without look-alikes; the caller writes it to
/// `server/.env` with mode 0600 instead of echoing it, so it never lands in a
/// transcript.
pub fn generate_password() -> String {
    use std::io::Read;

    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
    const LENGTH: usize = 24;
    let mut bytes = [0u8; LENGTH];
    let filled = std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .is_ok();
    if !filled {
        // Not reachable on a supported host; a clock/pid seed keeps the function
        // total instead of panicking on a machine without /dev/urandom.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let mut state = nanos ^ (u128::from(std::process::id()) << 32) | 1;
        for byte in &mut bytes {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            *byte = state as u8;
        }
    }
    bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn supplied(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    /// A writable directory standing in for the media disk.
    ///
    /// The resolver validates paths for real (that is the point), so the tests
    /// cannot use a fictional absolute path. The caller removes it.
    fn storage_root(label: &str) -> PathBuf {
        // Tests run in parallel, so the directory must be unique per call, not
        // per process: two tests sharing one root delete each other's paths.
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "churn-answers-{label}-{}-{serial}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("temp dir");
        root
    }

    /// Storage answers rooted at a real temp directory.
    fn storage(label: &str) -> (PathBuf, String, String) {
        let root = storage_root(label);
        let download = root.join("data");
        let media = download.join("media");
        fs::create_dir_all(&media).expect("storage dirs");
        (
            root,
            download.to_string_lossy().into_owned(),
            media.to_string_lossy().into_owned(),
        )
    }

    fn complete(pairs: &[(&str, &str)]) -> Result<Answers, Unresolved> {
        let (root, download, media) = storage("complete");
        let result = complete_with(&download, &media, pairs);
        let _ = fs::remove_dir_all(&root);
        result
    }

    /// Complete answers with both storage paths supplied, so a test can vary
    /// anything else without tripping the path checks.
    fn complete_with(
        download: &str,
        media: &str,
        pairs: &[(&str, &str)],
    ) -> Result<Answers, Unresolved> {
        let mut base = vec![
            ("DOWNLOAD_DIR", download),
            ("MEDIA_DIR", media),
            ("VPN_SERVICE_PROVIDER", "mullvad"),
            (
                "WIREGUARD_PRIVATE_KEY",
                "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=",
            ),
            ("WIREGUARD_ADDRESSES", "10.64.0.2/32"),
        ];
        base.extend_from_slice(pairs);
        resolve(&Answers::new(), &supplied(&base))
    }

    #[test]
    fn a_complete_set_of_answers_needs_no_prompt() {
        let answers = complete(&[]).expect("complete answers resolve");
        assert!(answers[&Question::DownloadDir].ends_with("/data"));
        assert!(answers[&Question::MediaDir].ends_with("/data/media"));
        assert_eq!(answers[&Question::VpnProvider], "mullvad");
        // A location was never supplied, so the provider default is used.
        assert_eq!(
            answers[&Question::VpnLocation],
            VpnProvider::Mullvad.default_location().unwrap()
        );
        // Every port is answered, so `Stack::apply` never falls back.
        for port in Port::ALL {
            assert!(
                answers.contains_key(&Question::Port(port)),
                "{port:?} must be answered"
            );
        }
    }

    #[test]
    fn missing_storage_is_named_by_env_key() {
        let err = resolve(
            &Answers::new(),
            &supplied(&[("VPN_SERVICE_PROVIDER", "mullvad")]),
        )
        .expect_err("no storage paths");
        // Mullvad needs both the key and the interface address.
        assert_eq!(
            err,
            Unresolved::Missing(vec![
                "DOWNLOAD_DIR",
                "MEDIA_DIR",
                "WIREGUARD_PRIVATE_KEY",
                "WIREGUARD_ADDRESSES"
            ])
        );
        assert!(err.message().contains("DOWNLOAD_DIR"));
    }

    #[test]
    fn the_provider_decides_which_credentials_are_required() {
        let (_root, download, media) = storage("pia");

        let pia = supplied(&[
            ("DOWNLOAD_DIR", &download),
            ("MEDIA_DIR", &media),
            ("VPN_SERVICE_PROVIDER", "private internet access"),
            ("OPENVPN_USER", "p1234567"),
            ("OPENVPN_PASSWORD", "secret"),
            // A WireGuard key supplied for an OpenVPN provider is ignored.
            ("WIREGUARD_PRIVATE_KEY", "not-even-base64"),
        ]);
        let answers = resolve(&Answers::new(), &pia).expect("PIA answers resolve");
        assert!(!answers.contains_key(&Question::WireguardPrivateKey));
        assert_eq!(answers[&Question::OpenvpnUser], "p1234567");

        let err = resolve(
            &Answers::new(),
            &supplied(&[
                ("DOWNLOAD_DIR", &download),
                ("MEDIA_DIR", &media),
                ("VPN_SERVICE_PROVIDER", "pia"),
            ]),
        )
        .expect_err("PIA needs OpenVPN credentials");
        assert_eq!(err.missing(), &["OPENVPN_USER", "OPENVPN_PASSWORD"]);
    }

    #[test]
    fn an_unknown_provider_is_rejected_with_the_known_ids() {
        let err = complete(&[("VPN_SERVICE_PROVIDER", "not-a-vpn")]).expect_err("unknown provider");
        let message = err.message();
        assert!(message.contains("not-a-vpn"), "{message}");
        assert!(message.contains("mullvad"), "{message}");
    }

    #[test]
    fn a_location_is_matched_case_insensitively_and_written_in_provider_spelling() {
        let answers = complete(&[("VPN_LOCATION", "netherlands")]).expect("location resolves");
        assert_eq!(answers[&Question::VpnLocation], "Netherlands");

        let err = complete(&[("VPN_LOCATION", "Atlantis")]).expect_err("unknown location");
        assert!(err.message().contains("Atlantis"), "{err}");
    }

    #[test]
    fn a_bad_wireguard_key_is_rejected_by_the_prompt_validator() {
        let err = complete(&[("WIREGUARD_PRIVATE_KEY", "too-short")])
            .expect_err("invalid key must be rejected");
        assert!(err.message().contains("base64"), "{err}");
    }

    #[test]
    fn storage_paths_are_checked_as_a_pair() {
        let (root, download, _media) = storage("pair");
        let err = complete_with(&download, &download, &[]).expect_err("equal paths");
        assert!(err.message().contains("cannot be the same path"), "{err}");

        let media = format!("{download}/media");
        fs::create_dir_all(&media).expect("media dir");
        let answers = complete_with(&download, &media, &[])
            .expect("media inside downloads is the default layout");
        assert_eq!(answers[&Question::MediaDir], media);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stored_answers_are_reused_when_nothing_is_supplied() {
        // The paths must still exist, because a rerun re-validates them.
        let (root, download, media) = storage("rerun");
        let first = complete_with(&download, &media, &[]).expect("first run");
        let second = resolve(&first, &HashMap::new()).expect("rerun is fully answered");
        assert_eq!(
            second[&Question::DownloadDir],
            first[&Question::DownloadDir]
        );
        assert_eq!(second[&Question::VpnProvider], "mullvad");
        // The rerun keeps whatever port the first run chose, even if that was a
        // fallback because the conventional one is busy on this host.
        assert_eq!(
            second[&Question::Port(Port::Jellyfin)],
            first[&Question::Port(Port::Jellyfin)]
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stored_port_is_kept_and_a_supplied_one_wins() {
        let (root, download, media) = storage("stored-port");
        let mut stored = complete_with(&download, &media, &[]).expect("first run");
        stored.insert(Question::Port(Port::Jellyfin), "9096".to_string());
        let answers = resolve(&stored, &HashMap::new()).expect("stored port kept");
        assert_eq!(answers[&Question::Port(Port::Jellyfin)], "9096");

        let answers =
            resolve(&stored, &supplied(&[("JELLYFIN_PORT", "9100")])).expect("supplied port wins");
        assert_eq!(answers[&Question::Port(Port::Jellyfin)], "9100");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_services_cannot_share_a_port() {
        let err = complete(&[("JELLYFIN_PORT", "9000"), ("SONARR_PORT", "9000")])
            .expect_err("duplicate port");
        assert!(err.message().contains("9000"), "{err}");
    }

    #[test]
    fn a_generated_password_is_long_and_never_contains_look_alikes() {
        let first = generate_password();
        let second = generate_password();
        assert_eq!(first.len(), 24);
        assert_ne!(first, second);
        for character in first.chars() {
            assert!(
                "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_".contains(character),
                "{character} must not be used"
            );
        }
    }
}
