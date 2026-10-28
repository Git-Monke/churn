use std::fs;

use churn::envfile;
use churn::question::{self, Question, Section};
use churn::stack::{self, Answers, Stack};

#[test]
fn data_dir_is_asked_once_when_both_stacks_selected() {
    let questions = stack::collect_questions(&[Stack::Server, Stack::Torrent]);
    let data_dir_asks = questions
        .iter()
        .filter(|q| **q == Question::DataDir)
        .count();
    assert_eq!(data_dir_asks, 1, "data dir must be deduped across stacks");

    // Everything else is still asked, so we did not dedupe too aggressively.
    assert!(questions.contains(&Question::WireguardPrivateKey));
    assert!(questions.contains(&Question::WireguardAddresses));
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
    assert!(last_vpn < first_storage, "VPN must be collected first: {questions:?}");
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
    answers.insert(Question::WireguardPrivateKey, "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=".into());
    answers.insert(Question::DataDir, "/data".into());

    let key = stack::summary(Question::WireguardPrivateKey, &answers).unwrap();
    assert!(!key.contains("Bpp22"), "secret leaked: {key}");
    assert!(key.contains("44 chars"));
    assert_eq!(stack::summary(Question::DataDir, &answers).unwrap(), "/data");
}

#[test]
fn env_rewrite_preserves_hand_added_keys() {
    let dir = std::env::temp_dir().join(format!("churn-test-{}", std::process::id()));
    let path = dir.join(".env");
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, "OLD_KEY=1\nHAND_EDITED=keep-me\nDATA_DIR=/old\n").unwrap();

    envfile::write_merged(&path, &[("DATA_DIR", "/new".to_string()), ("PUID", "1000".to_string())]).unwrap();
    let written = envfile::read(&path);

    assert_eq!(written.get("DATA_DIR").map(String::as_str), Some("/new"), "managed key updated");
    assert_eq!(written.get("PUID").map(String::as_str), Some("1000"), "managed key added");
    assert_eq!(
        written.get("HAND_EDITED").map(String::as_str),
        Some("keep-me"),
        "hand-added key must survive"
    );
    assert!(path.is_file());
    fs::remove_dir_all(&dir).unwrap();
}
