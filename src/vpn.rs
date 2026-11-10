//! Which VPN providers churn can configure, and what each one needs.
//!
//! Gluetun does the actual work. churn only has to pick the provider, collect
//! the credentials that provider uses and write the filter key it understands.
//! One table, so the installer, the `.env` writer, the compose security checks
//! and the docs cannot drift apart.
//!
//! Every provider here is configured over WireGuard except Private Internet
//! Access, which Gluetun only supports over OpenVPN. WireGuard is the default
//! for the rest because torrent traffic is throughput-bound.

use crate::question::validate_wireguard_address;

/// Mullvad accepted by the `SERVER_COUNTRIES` filter.
///
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -mullvad`.
/// Regenerate with `scripts/vpn-servers.sh` when the pinned Gluetun image moves.
#[rustfmt::skip]
const MULLVAD_LOCATIONS: &[&str] = &[
    "Albania", "Australia", "Austria", "Belgium", "Brazil", "Bulgaria", "Canada", "Chile",
    "Colombia", "Croatia", "Cyprus", "Czech Republic", "Denmark", "Estonia", "Finland",
    "France", "Germany", "Greece", "Hong Kong", "Hungary", "Indonesia", "Ireland", "Israel",
    "Italy", "Japan", "Malaysia", "Mexico", "Netherlands", "New Zealand", "Nigeria", "Norway",
    "Peru", "Philippines", "Poland", "Portugal", "Romania", "Serbia", "Singapore", "Slovakia",
    "Slovenia", "South Africa", "Spain", "Sweden", "Switzerland", "Thailand", "Turkey", "UK",
    "USA", "Ukraine",
];

/// IVPN accepted by the `SERVER_COUNTRIES` filter.
///
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -ivpn`.
#[rustfmt::skip]
const IVPN_LOCATIONS: &[&str] = &[
    "Australia", "Austria", "Belgium", "Brazil", "Bulgaria", "Canada", "Czech Republic",
    "Denmark", "Finland", "France", "Germany", "Greece", "Hong Kong", "Hungary", "Iceland",
    "Israel", "Italy", "Japan", "Luxembourg", "Malaysia", "Mexico", "Netherlands", "Norway",
    "Peru", "Poland", "Portugal", "Romania", "Serbia", "Singapore", "Slovakia", "South Africa",
    "Spain", "Sweden", "Switzerland", "Taiwan", "Ukraine", "United Kingdom", "United States",
];

/// ProtonVPN accepted by the `SERVER_COUNTRIES` filter.
///
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -protonvpn`.
#[rustfmt::skip]
const PROTONVPN_LOCATIONS: &[&str] = &[
    "Afghanistan", "Albania", "Algeria", "Angola", "Argentina", "Armenia", "Australia",
    "Austria", "Azerbaijan", "Bahrain", "Bangladesh", "Belarus", "Belgium", "Bhutan",
    "Bosnia and Herzegovina", "Brazil", "Brunei Darussalam", "Bulgaria", "Cambodia",
    "Cameroon", "Canada", "Chad", "Chile", "Colombia", "Comoros", "Costa Rica",
    "Cote d'Ivoire", "Croatia", "Cuba", "Cyprus", "Czech Republic", "Denmark",
    "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Eritrea", "Estonia", "Ethiopia",
    "Finland", "France", "Georgia", "Germany", "Ghana", "Greece", "Guatemala", "Honduras",
    "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Iraq", "Ireland", "Israel",
    "Italy", "Japan", "Jordan", "Kazakhstan", "Kenya", "Korea", "Kuwait",
    "Lao People's Democratic Republic", "Latvia", "Libya", "Lithuania", "Luxembourg",
    "Macedonia", "Malaysia", "Malta", "Mauritania", "Mauritius", "Mexico", "Moldova",
    "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar", "Nepal", "Netherlands",
    "New Zealand", "Nigeria", "Norway", "Oman", "Pakistan", "Panama", "Peru", "Philippines",
    "Poland", "Portugal", "Puerto Rico", "Qatar", "Romania", "Russian Federation", "Rwanda",
    "Saudi Arabia", "Senegal", "Serbia", "Singapore", "Slovakia", "Slovenia", "Somalia",
    "South Africa", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Sweden", "Switzerland",
    "Syrian Arab Republic", "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Togo", "Tunisia",
    "Turkey", "Turkmenistan", "Ukraine", "United Arab Emirates", "United Kingdom",
    "United States", "Uzbekistan", "Venezuela", "Vietnam", "Yemen",
];

/// NordVPN accepted by the `SERVER_COUNTRIES` filter.
///
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -nordvpn`.
#[rustfmt::skip]
const NORDVPN_LOCATIONS: &[&str] = &[
    "Albania", "Algeria", "Andorra", "Argentina", "Armenia", "Australia", "Austria",
    "Azerbaijan", "Bahamas", "Bangladesh", "Belgium", "Belize", "Bermuda", "Bhutan", "Bolivia",
    "Bosnia and Herzegovina", "Brazil", "Brunei Darussalam", "Bulgaria", "Cambodia", "Canada",
    "Cayman Islands", "Chile", "Colombia", "Costa Rica", "Croatia", "Cyprus", "Czech Republic",
    "Denmark", "Dominican Republic", "Ecuador", "Egypt", "El Salvador", "Estonia", "Finland",
    "France", "Georgia", "Germany", "Ghana", "Greece", "Greenland", "Guam", "Guatemala",
    "Honduras", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Ireland",
    "Isle of Man", "Israel", "Italy", "Jamaica", "Japan", "Jersey", "Kazakhstan", "Kenya",
    "Lao People's Democratic Republic", "Latvia", "Lebanon", "Liechtenstein", "Lithuania",
    "Luxembourg", "Malaysia", "Malta", "Mexico", "Moldova", "Monaco", "Mongolia", "Montenegro",
    "Morocco", "Myanmar", "Nepal", "Netherlands", "New Zealand", "Nigeria", "North Macedonia",
    "Norway", "Pakistan", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines",
    "Poland", "Portugal", "Puerto Rico", "Romania", "Serbia", "Singapore", "Slovakia",
    "Slovenia", "South Africa", "South Korea", "Spain", "Sri Lanka", "Sweden", "Switzerland",
    "Taiwan", "Thailand", "Trinidad and Tobago", "Turkey", "Ukraine", "United Arab Emirates",
    "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Venezuela", "Vietnam",
];

/// Surfshark accepted by the `SERVER_COUNTRIES` filter.
///
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers -surfshark`.
#[rustfmt::skip]
const SURFSHARK_LOCATIONS: &[&str] = &[
    "Albania", "Algeria", "Andorra", "Argentina", "Armenia", "Australia", "Austria",
    "Azerbaijan", "Bahamas", "Bangladesh", "Belgium", "Belize", "Bhutan", "Bolivia",
    "Bosnia and Herzegovina", "Brazil", "Brunei", "Bulgaria", "Cambodia", "Canada", "Chile",
    "Colombia", "Costa Rica", "Croatia", "Cyprus", "Czech Republic", "Denmark", "Ecuador",
    "Egypt", "Estonia", "Finland", "France", "Georgia", "Germany", "Ghana", "Greece",
    "Greenland", "Hong Kong", "Hungary", "Iceland", "India", "Indonesia", "Ireland",
    "Isle of Man", "Israel", "Italy", "Japan", "Kazakhstan", "Laos", "Latvia", "Liechtenstein",
    "Lithuania", "Luxembourg", "Macau", "Malaysia", "Malta", "Marocco", "Mexico", "Moldova",
    "Monaco", "Mongolia", "Montenegro", "Myanmar", "Nepal", "Netherlands", "New Zealand",
    "Nigeria", "North Macedonia", "Norway", "Pakistan", "Panama", "Paraguay", "Peru",
    "Philippines", "Poland", "Portugal", "Puerto Rico", "Romania", "Saudi Arabia", "Serbia",
    "Singapore", "Slovakia", "Slovenia", "South Africa", "South Korea", "Spain", "Sri Lanka",
    "Sweden", "Switzerland", "Taiwan", "Thailand", "Turkey", "Ukraine", "United Arab Emirates",
    "United Kingdom", "United States", "Uruguay", "Uzbekistan", "Venezuela", "Vietnam",
];

/// Private Internet Access accepted by the `SERVER_REGIONS` filter.
///
/// PIA's own region granularity (`US Seattle`, `NL Netherlands Streaming
/// Optimized`), not countries, so its filter key differs from the others.
/// Verbatim from `docker run --rm qmcgaw/gluetun:v3.41.3 format-servers
/// -private-internet-access`.
#[rustfmt::skip]
const PIA_REGIONS: &[&str] = &[
    "AU Adelaide", "AU Brisbane", "AU Melbourne", "AU Perth", "AU Sydney", "Albania",
    "Algeria", "Andorra", "Argentina", "Armenia", "Australia Streaming Optimized", "Austria",
    "Bahamas", "Bangladesh", "Belgium", "Bolivia", "Bosnia and Herzegovina", "Brazil",
    "Bulgaria", "CA Montreal", "CA Ontario", "CA Ontario Streaming Optimized", "CA Toronto",
    "CA Vancouver", "Cambodia", "Chile", "China", "Colombia", "Costa Rica", "Croatia",
    "Cyprus", "Czech Republic", "DE Berlin", "DE Frankfurt", "DE Germany Streaming Optimized",
    "DK Streaming Optimized", "Denmark", "ES Madrid", "ES Valencia", "Ecuador", "Egypt",
    "Estonia", "FI Helsinki", "FI Streaming Optimized", "France", "Georgia", "Greece",
    "Greenland", "Guatemala", "Hong Kong", "Hungary", "IT Milano", "IT Streaming Optimized",
    "Iceland", "India", "Indonesia", "Ireland", "Isle of Man", "Israel", "JP Tokyo",
    "Kazakhstan", "Latvia", "Liechtenstein", "Lithuania", "Luxembourg", "Macao", "Malaysia",
    "Malta", "Mexico", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco",
    "NL Netherlands Streaming Optimized", "Nepal", "Netherlands", "New Zealand", "Nigeria",
    "North Macedonia", "Norway", "Panama", "Peru", "Philippines", "Poland", "Portugal",
    "Qatar", "Romania", "SE Stockholm", "SE Streaming Optimized", "Saudi Arabia", "Serbia",
    "Singapore", "Slovakia", "Slovenia", "South Africa", "South Korea", "Sri Lanka",
    "Switzerland", "Taiwan", "Turkey", "UK London", "UK Manchester", "UK Southampton",
    "UK Streaming Optimized", "US Alabama", "US Alaska", "US Arkansas", "US Atlanta",
    "US Baltimore", "US California", "US Chicago", "US Connecticut", "US Denver", "US East",
    "US East Streaming Optimized", "US Florida", "US Honolulu", "US Houston", "US Idaho",
    "US Indiana", "US Iowa", "US Kansas", "US Kentucky", "US Las Vegas", "US Louisiana",
    "US Maine", "US Massachusetts", "US Michigan", "US Minnesota", "US Mississippi",
    "US Missouri", "US Montana", "US Nebraska", "US New Hampshire", "US New Mexico",
    "US New York", "US North Carolina", "US North Dakota", "US Ohio", "US Oklahoma",
    "US Oregon", "US Pennsylvania", "US Rhode Island", "US Salt Lake City", "US Seattle",
    "US Silicon Valley", "US South Carolina", "US South Dakota", "US Tennessee", "US Texas",
    "US Vermont", "US Virginia", "US Washington DC", "US West", "US West Streaming Optimized",
    "US West Virginia", "US Wilmington", "US Wisconsin", "US Wyoming", "Ukraine",
    "United Arab Emirates", "Uruguay", "Venezuela", "Vietnam",
];

/// The tunnel type Gluetun is told to use.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VpnProtocol {
    Wireguard,
    Openvpn,
}

impl VpnProtocol {
    /// Value for Gluetun's `VPN_TYPE`.
    pub fn as_env(self) -> &'static str {
        match self {
            VpnProtocol::Wireguard => "wireguard",
            VpnProtocol::Openvpn => "openvpn",
        }
    }

    /// Human wording for prompts, plans and the dashboard.
    pub fn label(self) -> &'static str {
        match self {
            VpnProtocol::Wireguard => "WireGuard",
            VpnProtocol::Openvpn => "OpenVPN",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum VpnProvider {
    Mullvad,
    Ivpn,
    ProtonVpn,
    NordVpn,
    Surfshark,
    PrivateInternetAccess,
}

impl VpnProvider {
    /// In the order a new user is most likely to look for them: the
    /// privacy-first providers first, then the mainstream ones.
    pub const ALL: [VpnProvider; 6] = [
        VpnProvider::Mullvad,
        VpnProvider::Ivpn,
        VpnProvider::ProtonVpn,
        VpnProvider::NordVpn,
        VpnProvider::Surfshark,
        VpnProvider::PrivateInternetAccess,
    ];

    /// The provider churn assumes when nothing else is known.
    pub const DEFAULT: VpnProvider = VpnProvider::Mullvad;

    pub fn label(self) -> &'static str {
        match self {
            VpnProvider::Mullvad => "Mullvad",
            VpnProvider::Ivpn => "IVPN",
            VpnProvider::ProtonVpn => "ProtonVPN",
            VpnProvider::NordVpn => "NordVPN",
            VpnProvider::Surfshark => "Surfshark",
            VpnProvider::PrivateInternetAccess => "Private Internet Access",
        }
    }

    /// Gluetun's id, written to `VPN_SERVICE_PROVIDER`.
    pub fn gluetun_id(self) -> &'static str {
        match self {
            VpnProvider::Mullvad => "mullvad",
            VpnProvider::Ivpn => "ivpn",
            VpnProvider::ProtonVpn => "protonvpn",
            VpnProvider::NordVpn => "nordvpn",
            VpnProvider::Surfshark => "surfshark",
            VpnProvider::PrivateInternetAccess => "private internet access",
        }
    }

    /// Read back a provider from a stored `VPN_SERVICE_PROVIDER`.
    ///
    /// Accepts either spelling of PIA's id so a hand-edited `.env` still reads
    /// back as the provider churn configured.
    pub fn from_gluetun_id(id: &str) -> Option<VpnProvider> {
        let id = id.trim();
        if id.eq_ignore_ascii_case("private internet access") || id.eq_ignore_ascii_case("pia") {
            return Some(VpnProvider::PrivateInternetAccess);
        }
        VpnProvider::ALL
            .into_iter()
            .find(|provider| provider.gluetun_id().eq_ignore_ascii_case(id))
    }

    pub fn protocol(self) -> VpnProtocol {
        match self {
            VpnProvider::PrivateInternetAccess => VpnProtocol::Openvpn,
            _ => VpnProtocol::Wireguard,
        }
    }

    /// Whether this provider tunnels over WireGuard (everything except PIA).
    pub fn uses_wireguard(self) -> bool {
        self.protocol() == VpnProtocol::Wireguard
    }

    /// Whether Gluetun needs `WIREGUARD_ADDRESSES` as well as the private key.
    pub fn needs_address(self) -> bool {
        matches!(
            self,
            VpnProvider::Mullvad | VpnProvider::Ivpn | VpnProvider::Surfshark
        )
    }

    /// The filter key Gluetun reads the location from.
    pub fn location_key(self) -> &'static str {
        match self {
            VpnProvider::PrivateInternetAccess => "SERVER_REGIONS",
            _ => "SERVER_COUNTRIES",
        }
    }

    /// Values accepted in [`Self::location_key`].
    pub fn locations(self) -> &'static [&'static str] {
        match self {
            VpnProvider::Mullvad => MULLVAD_LOCATIONS,
            VpnProvider::Ivpn => IVPN_LOCATIONS,
            VpnProvider::ProtonVpn => PROTONVPN_LOCATIONS,
            VpnProvider::NordVpn => NORDVPN_LOCATIONS,
            VpnProvider::Surfshark => SURFSHARK_LOCATIONS,
            VpnProvider::PrivateInternetAccess => PIA_REGIONS,
        }
    }

    /// The credential keys this provider cannot start without.
    ///
    /// The location is not included: Gluetun accepts an empty filter and picks
    /// a server itself, and churn only writes a location the user chose.
    pub fn required_env(self) -> &'static [&'static str] {
        match self.protocol() {
            VpnProtocol::Wireguard if self.needs_address() => {
                &["WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"]
            }
            VpnProtocol::Wireguard => &["WIREGUARD_PRIVATE_KEY"],
            VpnProtocol::Openvpn => &["OPENVPN_USER", "OPENVPN_PASSWORD"],
        }
    }

    /// One-line description for the provider picker.
    pub fn hint(self) -> &'static str {
        match self.protocol() {
            VpnProtocol::Wireguard if self.needs_address() => "WireGuard key + address",
            VpnProtocol::Wireguard => "WireGuard key only",
            VpnProtocol::Openvpn => "OpenVPN username + password",
        }
    }

    /// The location to preselect, preferring a likely-correct default so a user
    /// pressing Enter straight through gets a working tunnel.
    pub fn default_location(self) -> Option<&'static str> {
        let preferred: &[&str] = match self {
            VpnProvider::PrivateInternetAccess => &["NL Netherlands", "US Seattle"],
            _ => &["Netherlands", "Germany", "United States"],
        };
        preferred
            .iter()
            .find(|candidate| self.locations().contains(candidate))
            .copied()
    }

    /// Required credential keys that are absent or blank.
    ///
    /// Used after the wizard and on a `-y` rerun: Gluetun starts fine with an
    /// empty key and then silently fails the handshake, so churn refuses to
    /// write one. `get` resolves a key to its stored value.
    pub fn missing_credentials(self, get: impl Fn(&str) -> Option<String>) -> Vec<&'static str> {
        self.required_env()
            .iter()
            .copied()
            .filter(|key| {
                get(key)
                    .map(|value| value.trim().is_empty())
                    .unwrap_or(true)
            })
            .collect()
    }

    /// Where the user finds these credentials, shown before the prompts.
    pub fn help(self) -> &'static str {
        match self {
            VpnProvider::Mullvad => {
                "mullvad.net → Account → WireGuard config → generate a key\n\
                 Copy the PrivateKey and the IPv4 Address from one of its config files."
            }
            VpnProvider::Ivpn => {
                "ivpn.net → Account → WireGuard → generate a key\n\
                 Copy the PrivateKey and the IPv4 interface Address."
            }
            VpnProvider::ProtonVpn => {
                "account.proton.me → VPN → WireGuard → generate a config\n\
                 Copy the PrivateKey. ProtonVPN needs no interface address."
            }
            VpnProvider::NordVpn => {
                "my.nordaccount.com → NordVPN → manual configuration → WireGuard\n\
                 Copy the PrivateKey. NordVPN needs no interface address."
            }
            VpnProvider::Surfshark => {
                "surfshark.com → VPN → Manual setup → WireGuard → generate a keypair\n\
                 Copy the Private key and the Address from the downloaded config."
            }
            VpnProvider::PrivateInternetAccess => {
                "account.privateinternetaccess.com → VPN configuration → credentials\n\
                 Use the OpenVPN username and password, not the account login.\n\
                 This is the only provider churn configures over OpenVPN: there is\n\
                 no native WireGuard support in Gluetun for it yet."
            }
        }
    }

    /// Reject a value that is not in this provider's embedded filter list.
    pub fn validate_location(self, value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty() {
            return Err(format!(
                "A location is required, for example {}.",
                self.locations().first().copied().unwrap_or("Netherlands")
            ));
        }
        if self.locations().contains(&value) {
            return Ok(());
        }
        // Case-insensitive retry, so "netherlands" is corrected rather than
        // rejected outright; Gluetun itself matches case-insensitively.
        if let Some(known) = self
            .locations()
            .iter()
            .find(|known| known.eq_ignore_ascii_case(value))
        {
            return Err(format!("Use the provider's spelling: {known}."));
        }
        Err(format!(
            "{} is not a {} location Gluetun knows about.\n\
             Pick one from the list (it is embedded, so this works offline).",
            value,
            self.label()
        ))
    }

    /// Validate a complete credential set the way the installer would.
    pub fn validate_credentials(
        self,
        private_key: Option<&str>,
        address: Option<&str>,
        user: Option<&str>,
        password: Option<&str>,
    ) -> Result<(), String> {
        match self.protocol() {
            VpnProtocol::Wireguard => {
                crate::question::validate_wireguard_key(private_key.unwrap_or_default())
                    .map_err(|message| format!("{} private key: {message}", self.label()))?;
                if self.needs_address() {
                    validate_wireguard_address(address.unwrap_or_default())
                        .map_err(|message| format!("{} address: {message}", self.label()))?;
                }
                Ok(())
            }
            VpnProtocol::Openvpn => {
                if user.unwrap_or_default().trim().is_empty() {
                    return Err(format!("{} needs an OpenVPN username.", self.label()));
                }
                if password.unwrap_or_default().is_empty() {
                    return Err(format!("{} needs an OpenVPN password.", self.label()));
                }
                Ok(())
            }
        }
    }
}

/// The keys a provider switch has to remove from `.env`.
///
/// Writing a provider's own keys is not enough: a previous install may have
/// left the other protocol's credentials behind, and Gluetun ignores them while
/// the security checks reject them.
pub fn stale_credential_keys(provider: VpnProvider) -> Vec<&'static str> {
    const ALL: [&str; 4] = [
        "WIREGUARD_PRIVATE_KEY",
        "WIREGUARD_ADDRESSES",
        "OPENVPN_USER",
        "OPENVPN_PASSWORD",
    ];
    ALL.into_iter()
        .filter(|key| !provider.required_env().contains(key))
        .collect()
}

/// Filter keys that do not belong to this provider.
pub fn stale_location_keys(provider: VpnProvider) -> Vec<&'static str> {
    ["SERVER_COUNTRIES", "SERVER_REGIONS"]
        .into_iter()
        .filter(|key| *key != provider.location_key())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_round_trips_through_its_gluetun_id() {
        for provider in VpnProvider::ALL {
            assert_eq!(
                VpnProvider::from_gluetun_id(provider.gluetun_id()),
                Some(provider),
                "{} did not round trip",
                provider.label()
            );
        }
        assert_eq!(
            VpnProvider::from_gluetun_id("private internet access"),
            Some(VpnProvider::PrivateInternetAccess)
        );
        assert_eq!(
            VpnProvider::from_gluetun_id("PIA"),
            Some(VpnProvider::PrivateInternetAccess)
        );
        assert_eq!(
            VpnProvider::from_gluetun_id(" Mullvad "),
            Some(VpnProvider::Mullvad)
        );
        assert_eq!(VpnProvider::from_gluetun_id("expressvpn"), None);
        assert_eq!(VpnProvider::from_gluetun_id(""), None);
    }

    #[test]
    fn only_pia_uses_openvpn() {
        for provider in VpnProvider::ALL {
            let expected = if provider == VpnProvider::PrivateInternetAccess {
                VpnProtocol::Openvpn
            } else {
                VpnProtocol::Wireguard
            };
            assert_eq!(provider.protocol(), expected, "{}", provider.label());
        }
        assert_eq!(VpnProtocol::Wireguard.as_env(), "wireguard");
        assert_eq!(VpnProtocol::Openvpn.as_env(), "openvpn");
    }

    #[test]
    fn providers_that_need_an_interface_address_are_the_documented_three() {
        let needing: Vec<&str> = VpnProvider::ALL
            .into_iter()
            .filter(|provider| provider.needs_address())
            .map(VpnProvider::label)
            .collect();
        assert_eq!(needing, vec!["Mullvad", "IVPN", "Surfshark"]);
    }

    #[test]
    fn required_env_matches_the_protocol_and_address_need() {
        assert_eq!(
            VpnProvider::Mullvad.required_env(),
            &["WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"]
        );
        assert_eq!(
            VpnProvider::ProtonVpn.required_env(),
            &["WIREGUARD_PRIVATE_KEY"]
        );
        assert_eq!(
            VpnProvider::NordVpn.required_env(),
            &["WIREGUARD_PRIVATE_KEY"]
        );
        assert_eq!(
            VpnProvider::PrivateInternetAccess.required_env(),
            &["OPENVPN_USER", "OPENVPN_PASSWORD"]
        );
    }

    #[test]
    fn only_pia_filters_on_regions() {
        assert_eq!(
            VpnProvider::PrivateInternetAccess.location_key(),
            "SERVER_REGIONS"
        );
        for provider in VpnProvider::ALL {
            if provider != VpnProvider::PrivateInternetAccess {
                assert_eq!(provider.location_key(), "SERVER_COUNTRIES");
            }
        }
    }

    #[test]
    fn location_lists_are_non_empty_sorted_and_unique() {
        for provider in VpnProvider::ALL {
            let locations = provider.locations();
            assert!(locations.len() > 3, "{} has no locations", provider.label());
            let mut sorted = locations.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(
                locations,
                sorted.as_slice(),
                "{} locations must be sorted and unique",
                provider.label()
            );
        }
    }

    #[test]
    fn every_provider_list_contains_a_likely_default() {
        // The plan's fallback for an unset location; keep it honest.
        assert!(VpnProvider::Mullvad.locations().contains(&"Netherlands"));
        assert!(VpnProvider::Surfshark.locations().contains(&"Netherlands"));
        assert!(
            VpnProvider::PrivateInternetAccess
                .locations()
                .contains(&"US Seattle")
        );
    }

    #[test]
    fn location_validation_rejects_unknown_values_and_fixes_case() {
        assert!(VpnProvider::Mullvad.validate_location("Sweden").is_ok());
        // Mullvad's own spelling, not the long name.
        assert!(VpnProvider::Mullvad.validate_location("UK").is_ok());
        assert!(
            VpnProvider::Mullvad
                .validate_location("United Kingdom")
                .is_err()
        );
        assert_eq!(
            VpnProvider::Mullvad.validate_location("sweden"),
            Err("Use the provider's spelling: Sweden.".to_string())
        );
        assert!(VpnProvider::Mullvad.validate_location("").is_err());
        // PIA regions are not countries.
        assert!(
            VpnProvider::PrivateInternetAccess
                .validate_location("US Seattle")
                .is_ok()
        );
        assert!(
            VpnProvider::PrivateInternetAccess
                .validate_location("United States")
                .is_err()
        );
    }

    #[test]
    fn credential_validation_follows_the_protocol() {
        let key = "wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=";
        assert!(
            VpnProvider::ProtonVpn
                .validate_credentials(Some(key), None, None, None)
                .is_ok()
        );
        assert!(
            VpnProvider::Mullvad
                .validate_credentials(Some(key), None, None, None)
                .is_err(),
            "Mullvad needs an address"
        );
        assert!(
            VpnProvider::Mullvad
                .validate_credentials(Some(key), Some("10.64.0.2/32"), None, None)
                .is_ok()
        );
        assert!(
            VpnProvider::PrivateInternetAccess
                .validate_credentials(None, None, Some("user"), Some("pass"))
                .is_ok()
        );
        assert!(
            VpnProvider::PrivateInternetAccess
                .validate_credentials(None, None, Some("user"), Some(""))
                .is_err()
        );
    }

    #[test]
    fn stale_keys_are_the_other_protocols_credentials() {
        assert_eq!(
            stale_credential_keys(VpnProvider::Mullvad),
            vec!["OPENVPN_USER", "OPENVPN_PASSWORD"]
        );
        assert_eq!(
            stale_credential_keys(VpnProvider::PrivateInternetAccess),
            vec!["WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"]
        );
        assert_eq!(
            stale_location_keys(VpnProvider::Mullvad),
            vec!["SERVER_REGIONS"]
        );
        assert_eq!(
            stale_location_keys(VpnProvider::PrivateInternetAccess),
            vec!["SERVER_COUNTRIES"]
        );
    }

    #[test]
    fn missing_credentials_lists_only_blank_required_keys() {
        let empty = |_: &str| None;
        assert_eq!(
            VpnProvider::Mullvad.missing_credentials(empty),
            vec!["WIREGUARD_PRIVATE_KEY", "WIREGUARD_ADDRESSES"]
        );
        assert_eq!(
            VpnProvider::ProtonVpn.missing_credentials(empty),
            vec!["WIREGUARD_PRIVATE_KEY"]
        );
        assert_eq!(
            VpnProvider::PrivateInternetAccess.missing_credentials(empty),
            vec!["OPENVPN_USER", "OPENVPN_PASSWORD"]
        );

        let blank = |_: &str| Some("   ".to_string());
        assert!(
            VpnProvider::ProtonVpn
                .missing_credentials(blank)
                .contains(&"WIREGUARD_PRIVATE_KEY"),
            "whitespace is not a credential"
        );

        let filled = |key: &str| Some(format!("{key}-value"));
        assert!(
            VpnProvider::PrivateInternetAccess
                .missing_credentials(filled)
                .is_empty()
        );
    }
}
