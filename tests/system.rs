use churn::system::{self, Distro};

#[test]
fn detects_supported_distributions() {
    assert_eq!(
        system::detect_distro("ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\n"),
        Distro::Ubuntu
    );
    assert_eq!(
        system::detect_distro("ID=debian\nVERSION_CODENAME=bookworm\n"),
        Distro::Debian
    );
    assert_eq!(
        system::detect_distro("ID=fedora\nVERSION_ID=41\n"),
        Distro::Fedora
    );
    assert_eq!(system::detect_distro("ID=arch\n"), Distro::Arch);
}

#[test]
fn derivatives_resolve_through_id_like() {
    assert_eq!(
        system::detect_distro("ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"),
        Distro::Ubuntu
    );
    assert_eq!(
        system::detect_distro("ID=endeavouros\nID_LIKE=\"arch\"\n"),
        Distro::Arch
    );
    assert_eq!(
        system::detect_distro("ID=rhel\nID_LIKE=\"fedora\"\n"),
        Distro::Fedora
    );
}

#[test]
fn unsupported_distribution_is_reported_by_id() {
    assert_eq!(
        system::detect_distro("ID=opensuse-tumbleweed\n"),
        Distro::Unsupported("opensuse-tumbleweed".to_string())
    );
    assert_eq!(
        system::detect_distro(""),
        Distro::Unsupported("unknown Linux".to_string())
    );
    assert!(system::detect_distro("ID=nixos\n")
        .install_steps()
        .is_none());
}

#[test]
fn quoted_os_release_values_are_parsed() {
    // ID_LIKE is commonly quoted; the quotes must not become part of the value.
    assert_eq!(
        system::detect_distro("ID=\"pop\"\nID_LIKE=\"ubuntu debian\"\n"),
        Distro::Ubuntu
    );
}

#[test]
fn every_supported_distro_has_install_steps() {
    for distro in [Distro::Ubuntu, Distro::Debian, Distro::Fedora, Distro::Arch] {
        let steps = distro
            .install_steps()
            .expect("supported distro needs steps");
        assert!(!steps.is_empty(), "{distro:?} has no install steps");
        assert!(
            steps.iter().any(|step| step.command.contains("docker")),
            "{distro:?} does not install docker"
        );
    }
}

#[test]
fn uid_is_read_from_proc_status() {
    assert_eq!(
        system::parse_uid("Name:\tchurn\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n"),
        Some(0)
    );
    assert_eq!(
        system::parse_uid("Name:\tchurn\nUid:\t1000\t1000\t1000\t1000\n"),
        Some(1000)
    );
    assert_eq!(system::parse_uid("Name:\tchurn\n"), None);
}
