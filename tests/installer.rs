use std::fs;
use std::io::Write;

use churn::envfile;
use churn::mullvad;
use churn::question::{self, Question, Section};
use churn::stack::{self, Answers, Stack};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

#[test]
fn data_dir_is_asked_once_when_both_stacks_selected() {
    let questions = stack::collect_questions(&[Stack::Server, Stack::Torrent]);
    let data_dir_asks = questions
        .iter()
        .filter(|q| **q == Question::DataDir)
        .count();
    assert_eq!(data_dir_asks, 1, "data dir must be deduped across stacks");

    // Everything else is still asked, so we did not dedupe too aggressively.
    assert!(questions.contains(&Question::WireguardArchive));
    // Credentials come from the archive instead of separate prompts.
    assert!(!questions.contains(&Question::WireguardPrivateKey));
    assert!(!questions.contains(&Question::WireguardAddresses));
}

#[test]
fn server_alone_only_asks_for_storage() {
    let questions = stack::collect_questions(&[Stack::Server]);
    assert_eq!(questions, vec![Question::DataDir]);
}

#[test]
fn vpn_questions_come_before_storage() {
    let questions = stack::collect_questions(&[Stack::Server, Stack::Torrent]);
    let first_storage = questions
        .iter()
        .position(|q| q.section() == Section::Storage)
        .expect("a storage question");
    let last_vpn = questions
        .iter()
        .rposition(|q| q.section() == Section::Vpn)
        .expect("a vpn question");
    assert!(
        last_vpn < first_storage,
        "VPN must be collected first: {questions:?}"
    );
}

#[test]
fn wireguard_key_must_decode_to_32_bytes() {
    assert!(question::validate_wireguard_key("not-a-key").is_err());
    // A real Mullvad key shape: 32 random bytes, base64.
    let good = "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=";
    assert!(question::validate_wireguard_key(good).is_ok());
    // 16-byte value: the classic wrong thing to copy.
    assert!(question::validate_wireguard_key("MTIzNDU2Nzg5MDEyMzQ1Ng==").is_err());
}

#[test]
fn wireguard_address_must_be_ipv4_cidr() {
    assert!(question::validate_wireguard_address("10.64.12.34/32").is_ok());
    assert!(question::validate_wireguard_address("10.64.12.34").is_err());
    assert!(question::validate_wireguard_address("fd00::1/128").is_err());
    assert!(question::validate_wireguard_address("10.64.12.34/33").is_err());
}

#[test]
fn data_dir_must_be_absolute_and_writable() {
    assert!(question::validate_data_dir("relative/path").is_err());
    assert!(question::validate_data_dir("/tmp").is_ok());
    assert!(question::validate_data_dir("/definitely/not/here/\u{1}").is_err());
}

#[test]
fn paths_are_normalised() {
    assert_eq!(question::normalize_path("/data/media/"), "/data/media");
    assert_eq!(question::normalize_path("/"), "/");
}

#[test]
fn secrets_are_masked_in_summaries() {
    let mut answers = Answers::new();
    answers.insert(
        Question::WireguardPrivateKey,
        "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=".into(),
    );
    answers.insert(Question::DataDir, "/data".into());

    let key = stack::summary(Question::WireguardPrivateKey, &answers).unwrap();
    assert!(!key.contains("Bpp22"), "secret leaked: {key}");
    assert!(key.contains("44 chars"));
    assert_eq!(
        stack::summary(Question::DataDir, &answers).unwrap(),
        "/data"
    );
}

#[test]
fn env_rewrite_preserves_hand_added_keys() {
    let dir = std::env::temp_dir().join(format!("churn-test-{}", std::process::id()));
    let path = dir.join(".env");
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, "OLD_KEY=1\nHAND_EDITED=keep-me\nDATA_DIR=/old\n").unwrap();

    envfile::write_merged(
        &path,
        &[
            ("DATA_DIR", "/new".to_string()),
            ("PUID", "1000".to_string()),
        ],
    )
    .unwrap();
    let written = envfile::read(&path);

    assert_eq!(
        written.get("DATA_DIR").map(String::as_str),
        Some("/new"),
        "managed key updated"
    );
    assert_eq!(
        written.get("PUID").map(String::as_str),
        Some("1000"),
        "managed key added"
    );
    assert_eq!(
        written.get("HAND_EDITED").map(String::as_str),
        Some("keep-me"),
        "hand-added key must survive"
    );
    assert!(path.is_file());
    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn env_upsert_updates_one_key_without_reformatting_the_file() {
    let dir = std::env::temp_dir().join(format!("churn-upsert-test-{}", std::process::id()));
    let path = dir.join(".env");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        &path,
        "# generated\nDATA_DIR=/data\n# hand edited\nJELLYFIN_API_KEY=old\nKEEP=yes\n",
    )
    .unwrap();

    envfile::upsert(&path, "JELLYFIN_API_KEY", "new").unwrap();

    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# generated\nDATA_DIR=/data\n# hand edited\nJELLYFIN_API_KEY=new\nKEEP=yes\n"
    );

    envfile::upsert(&path, "JELLYFIN_API_KEY", "newer").unwrap();
    let written = fs::read_to_string(&path).unwrap();
    assert_eq!(written.matches("JELLYFIN_API_KEY=").count(), 1);
    assert!(written.contains("JELLYFIN_API_KEY=newer"));

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn derives_the_exit_country_from_the_config_filename() {
    assert_eq!(
        mullvad::country_for_entry("us-atl-wg-001.conf"),
        Some("USA")
    );
    assert_eq!(
        mullvad::country_for_entry("nl-ams-wg-002.conf"),
        Some("Netherlands")
    );
    assert_eq!(mullvad::country_for_entry("gb-lon-wg-101.conf"), Some("UK"));
    assert_eq!(
        mullvad::country_for_entry("some/nested/gb-man-wg-003.conf"),
        Some("UK")
    );
}

#[test]
fn unknown_config_filenames_do_not_guess_a_country() {
    assert_eq!(mullvad::country_for_entry("readme.conf"), None);
    assert_eq!(mullvad::country_for_entry("zz-place-wg-001.conf"), None);
    assert_eq!(mullvad::country_for_entry(""), None);
}

const CONF: &str = "\
[Interface]
# Device: Square Dragon
PrivateKey = sBIsVvs1dBhkR8UAbY+1lTXchldJEMTV3H3Br/PQfkI=
Address = 10.65.160.71/32,fc00:bbbb:bbbb:bb01::2:a046/128
DNS = 10.64.0.1

[Peer]
PublicKey = nvyBkaEXHwyPBAm8spGB0TFzf2W5wPAl8EEuJ0t+bzs=
AllowedIPs = 0.0.0.0/0,::0/0
Endpoint = 45.134.140.130:51820
";

#[test]
fn parses_private_key_and_ipv4_address_from_conf() {
    let config = mullvad::parse(CONF).unwrap();
    assert_eq!(
        config.private_key,
        "sBIsVvs1dBhkR8UAbY+1lTXchldJEMTV3H3Br/PQfkI="
    );
    assert_eq!(config.address, "10.65.160.71/32");
}

#[test]
fn conf_parser_rejects_incomplete_or_invalid_configs() {
    assert!(mullvad::parse("[Interface]\nAddress = 10.0.0.1/32\n").is_err());
    assert!(
        mullvad::parse("[Interface]\nPrivateKey = sBIsVvs1dBhkR8UAbY+1lTXchldJEMTV3H3Br/PQfkI=\n")
            .is_err()
    );
    assert!(
        mullvad::parse("[Interface]\nPrivateKey = not-a-key\nAddress = 10.0.0.1/32\n").is_err()
    );
    assert!(
        mullvad::parse(
            "[Interface]\nPrivateKey = sBIsVvs1dBhkR8UAbY+1lTXchldJEMTV3H3Br/PQfkI=\nAddress = fd00::1/128\n"
        )
        .is_err(),
        "IPv6-only configs have no address gluetun can use"
    );
}

#[test]
fn reads_conf_entries_from_a_zip_archive() {
    let dir = std::env::temp_dir().join(format!("churn-zip-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("configs.zip");
    {
        let mut zip = ZipWriter::new(fs::File::create(&path).unwrap());
        zip.start_file("b.conf", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(CONF.as_bytes()).unwrap();
        zip.start_file("a.conf", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(CONF.as_bytes()).unwrap();
        zip.start_file("readme.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"ignore me").unwrap();
        zip.finish().unwrap();
    }

    let entries = mullvad::entries(&path).unwrap();
    assert_eq!(entries, vec!["a.conf", "b.conf"]);
    let config = mullvad::load(&path, "a.conf").unwrap();
    assert_eq!(config.address, "10.65.160.71/32");

    // Hundreds of configs must not become a prompt: pick the first sorted one.
    let (selected, config) = mullvad::select_config(&path).unwrap();
    assert_eq!(selected, "a.conf");
    assert_eq!(
        config.private_key,
        mullvad::parse(CONF).unwrap().private_key
    );
    fs::remove_dir_all(&dir).unwrap();
}
