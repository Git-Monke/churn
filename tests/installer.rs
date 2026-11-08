use std::fs;
use std::io::Write;
use std::process::Command;

use churn::envfile;
use churn::mullvad;
use churn::ports::{self, Port};
use churn::question::{self, Question, Section};
use churn::stack::{self, Answers, Stack};
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

#[test]
fn storage_is_asked_once_when_both_stacks_selected() {
    let questions = stack::collect_questions(&[Stack::Server, Stack::Torrent]);
    for question in [Question::DownloadDir, Question::MediaDir] {
        let asks = questions.iter().filter(|q| **q == question).count();
        assert_eq!(asks, 1, "{question:?} must be deduped across stacks");
    }

    // Everything else is still asked, so we did not dedupe too aggressively.
    assert!(questions.contains(&Question::WireguardArchive));
    // Credentials come from the archive instead of separate prompts.
    assert!(!questions.contains(&Question::WireguardPrivateKey));
    assert!(!questions.contains(&Question::WireguardAddresses));
}

#[test]
fn server_alone_asks_for_storage_and_host_ports() {
    let questions = stack::collect_questions(&[Stack::Server]);
    assert_eq!(
        questions,
        vec![
            Question::DownloadDir,
            Question::MediaDir,
            Question::Port(Port::Jellyfin),
            Question::Port(Port::Sonarr),
            Question::Port(Port::Radarr),
            Question::Port(Port::Dashboard),
        ]
    );
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
fn qbittorrent_init_keeps_the_key_and_accepts_forwarded_ports() {
    let dir = std::env::temp_dir().join(format!(
        "churn-qbittorrent-init-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    let conf_dir = dir.join("qBittorrent");
    fs::create_dir_all(&conf_dir).unwrap();
    fs::write(
        conf_dir.join("qBittorrent.conf"),
        [
            "[Preferences]",
            "WebUI\\APIKey=legacy-key",
            "",
            "[WebUI]",
            "Address=*",
            "ServerDomains=*",
            "HostHeaderValidation=true",
        ]
        .join("\n"),
    )
    .unwrap();

    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("torrent/scripts/qbittorrent-init.sh");
    let status = Command::new("sh")
        .arg(script)
        .env("QBITTORRENT_CONFIG_ROOT", &dir)
        .env("PUID", "1000")
        .env("PGID", "1000")
        .status()
        .unwrap();
    assert!(status.success());

    let written = fs::read_to_string(conf_dir.join("qBittorrent.conf")).unwrap();
    assert!(written.contains("[WebUI]\nAPIKey=legacy-key"));
    assert!(written.contains("HostHeaderValidation=false"));
    assert!(!written.contains("HostHeaderValidation=true"));
    assert!(!written.contains("WebUI\\APIKey="));

    let fresh = dir.join("fresh");
    fs::create_dir_all(&fresh).unwrap();
    let status = Command::new("sh")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("torrent/scripts/qbittorrent-init.sh"),
        )
        .env("QBITTORRENT_CONFIG_ROOT", &fresh)
        .env("PUID", "1000")
        .env("PGID", "1000")
        .status()
        .unwrap();
    assert!(status.success());
    let seeded = fs::read_to_string(fresh.join("qBittorrent/qBittorrent.conf")).unwrap();
    assert!(seeded.contains("APIKey=qbt_"));
    assert!(seeded.contains("HostHeaderValidation=false"));

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn qbittorrent_port_must_be_unprivileged() {
    assert!(ports::validate_port("8080").is_ok());
    assert!(ports::validate_port("1024").is_ok());
    assert!(ports::validate_port("80").is_err());
    assert!(ports::validate_port("70000").is_err());
    assert!(ports::validate_port("http").is_err());
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
fn media_inside_downloads_is_the_default_layout() {
    assert!(question::validate_storage_paths("/data", "/data/media").is_ok());
    // Trailing slashes are normalised before comparing, not rejected.
    assert!(question::validate_storage_paths("/data/", "/srv/library").is_ok());
    // Completely separate disks are the other intended layout.
    assert!(question::validate_storage_paths("/mnt/ssd", "/mnt/hdd/media").is_ok());
}

#[test]
fn equal_or_inverted_storage_paths_are_rejected() {
    let same = question::validate_storage_paths("/data", "/data/").unwrap_err();
    assert!(
        same.contains("cannot be the same path"),
        "unexpected message: {same}"
    );

    let nested =
        question::validate_storage_paths("/data/media/downloads", "/data/media").unwrap_err();
    assert!(
        nested.contains("cannot live inside the media directory"),
        "unexpected message: {nested}"
    );
    // Jellyfin indexing in-progress files is the reason, not an arbitrary rule.
    assert!(nested.contains("still downloading"));
}

#[test]
fn secrets_are_masked_in_summaries() {
    let mut answers = Answers::new();
    answers.insert(
        Question::WireguardPrivateKey,
        "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=".into(),
    );
    answers.insert(Question::DownloadDir, "/srv/downloads".into());

    let key = stack::summary(Question::WireguardPrivateKey, &answers).unwrap();
    assert!(!key.contains("Bpp22"), "secret leaked: {key}");
    assert!(key.contains("44 chars"));
    assert_eq!(
        stack::summary(Question::DownloadDir, &answers).unwrap(),
        "/srv/downloads"
    );
}

#[test]
fn env_rewrite_preserves_hand_added_keys() {
    let dir = std::env::temp_dir().join(format!("churn-test-{}", std::process::id()));
    let path = dir.join(".env");
    fs::create_dir_all(&dir).unwrap();
    fs::write(&path, "OLD_KEY=1\nHAND_EDITED=keep-me\nDOWNLOAD_DIR=/old\n").unwrap();

    envfile::write_merged(
        &path,
        &[
            ("DOWNLOAD_DIR", "/new".to_string()),
            ("PUID", "1000".to_string()),
        ],
    )
    .unwrap();
    let written = envfile::read(&path);

    assert_eq!(
        written.get("DOWNLOAD_DIR").map(String::as_str),
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
fn legacy_data_dir_is_read_as_the_download_directory() {
    let path = std::env::temp_dir().join(format!("churn-legacy-env-{}", std::process::id()));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "DATA_DIR=/old\nPUID=1000\n").unwrap();
    let env = envfile::read(&path);

    assert_eq!(
        envfile::storage_path(&env, "DOWNLOAD_DIR").as_deref(),
        Some("/old")
    );
    // The legacy key is not a stand-in for every path, only the download one.
    assert_eq!(envfile::storage_path(&env, "MEDIA_DIR"), None);

    // Rerunning the installer must leave one key, not two.
    envfile::write_merged(
        &path,
        &[
            ("DOWNLOAD_DIR", "/new".to_string()),
            ("MEDIA_DIR", "/new/media".to_string()),
        ],
    )
    .unwrap();
    let written = fs::read_to_string(&path).unwrap();
    assert!(written.contains("DOWNLOAD_DIR=/new\n"));
    assert!(written.contains("MEDIA_DIR=/new/media\n"));
    assert!(
        !written.contains("DATA_DIR="),
        "the legacy key survived: {written}"
    );
    fs::remove_file(&path).unwrap();
}

#[test]
fn managed_env_writes_both_storage_keys_and_derives_the_media_default() {
    let mut answers = Answers::new();
    answers.insert(Question::DownloadDir, "/srv/downloads/".into());
    let stored = envfile::EnvMap::new();

    let managed = Stack::Server.managed_env_with(&answers, &stored);
    let value = |key: &str| {
        managed
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_str())
    };

    assert_eq!(value("DOWNLOAD_DIR"), Some("/srv/downloads"));
    assert_eq!(
        value("MEDIA_DIR"),
        Some("/srv/downloads/media"),
        "media defaults to a folder inside the download directory"
    );
    assert!(
        !managed.iter().any(|(name, _)| *name == "DATA_DIR"),
        "the legacy key must never be written"
    );
}

#[test]
fn managed_env_keeps_an_explicit_media_answer() {
    let mut answers = Answers::new();
    answers.insert(Question::DownloadDir, "/mnt/ssd".into());
    answers.insert(Question::MediaDir, "/mnt/hdd/media/".into());

    let managed = Stack::Torrent.managed_env_with(&answers, &envfile::EnvMap::new());
    let value = |key: &str| {
        managed
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(value("DOWNLOAD_DIR"), Some("/mnt/ssd"));
    assert_eq!(value("MEDIA_DIR"), Some("/mnt/hdd/media"));
}

#[test]
fn env_upsert_updates_one_key_without_reformatting_the_file() {
    let dir = std::env::temp_dir().join(format!("churn-upsert-test-{}", std::process::id()));
    let path = dir.join(".env");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        &path,
        "# generated\nDOWNLOAD_DIR=/data\n# hand edited\nJELLYFIN_API_KEY=old\nKEEP=yes\n",
    )
    .unwrap();

    envfile::upsert(&path, "JELLYFIN_API_KEY", "new").unwrap();

    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# generated\nDOWNLOAD_DIR=/data\n# hand edited\nJELLYFIN_API_KEY=new\nKEEP=yes\n"
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
