//! Reading Mullvad WireGuard configuration archives.
//!
//! Mullvad's "WireGuard configuration" download is a zip of `.conf` files.
//! Every file in one archive carries the same private key and interface address,
//! so the installer only needs to read one of them.

use std::fs::File;
use std::io::Read;
use std::net::Ipv4Addr;
use std::path::Path;

use zip::ZipArchive;

use crate::question::{validate_wireguard_address, validate_wireguard_key};

pub const CONFIG_EXTENSION: &str = ".conf";

/// Mullvad's ISO country codes mapped to the country names Gluetun accepts in
/// `SERVER_COUNTRIES`. Mullvad encodes the country in each config filename, so
/// the selected `.conf` tells us where the tunnel should exit.
const COUNTRY_NAMES: [(&str, &str); 50] = [
    ("al", "Albania"),
    ("ar", "Argentina"),
    ("at", "Austria"),
    ("au", "Australia"),
    ("be", "Belgium"),
    ("bg", "Bulgaria"),
    ("br", "Brazil"),
    ("ca", "Canada"),
    ("ch", "Switzerland"),
    ("cl", "Chile"),
    ("co", "Colombia"),
    ("cy", "Cyprus"),
    ("cz", "Czech Republic"),
    ("de", "Germany"),
    ("dk", "Denmark"),
    ("ee", "Estonia"),
    ("es", "Spain"),
    ("fi", "Finland"),
    ("fr", "France"),
    ("gb", "UK"),
    ("gr", "Greece"),
    ("hk", "Hong Kong"),
    ("hr", "Croatia"),
    ("hu", "Hungary"),
    ("id", "Indonesia"),
    ("ie", "Ireland"),
    ("il", "Israel"),
    ("it", "Italy"),
    ("jp", "Japan"),
    ("mx", "Mexico"),
    ("my", "Malaysia"),
    ("ng", "Nigeria"),
    ("nl", "Netherlands"),
    ("no", "Norway"),
    ("nz", "New Zealand"),
    ("pe", "Peru"),
    ("ph", "Philippines"),
    ("pl", "Poland"),
    ("pt", "Portugal"),
    ("rs", "Serbia"),
    ("ro", "Romania"),
    ("se", "Sweden"),
    ("sg", "Singapore"),
    ("si", "Slovenia"),
    ("sk", "Slovakia"),
    ("th", "Thailand"),
    ("tr", "Turkey"),
    ("ua", "Ukraine"),
    ("us", "USA"),
    ("za", "South Africa"),
];

/// Country name for a Mullvad config entry such as `us-atl-wg-001.conf`.
///
/// Entries may include a directory prefix; only the filename is inspected.
/// Unknown or non-ISO prefixes return `None` so callers can keep an explicit
/// `SERVER_COUNTRIES` value instead of guessing.
pub fn country_for_entry(entry: &str) -> Option<&'static str> {
    let name = Path::new(entry).file_name()?.to_str()?;
    let code = name.split(['-', '.']).next()?.to_ascii_lowercase();
    if code.len() != 2 {
        return None;
    }
    COUNTRY_NAMES
        .iter()
        .find(|(known, _)| *known == code)
        .map(|(_, country)| *country)
}

/// Credentials pulled out of a Mullvad WireGuard config file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireguardConfig {
    pub private_key: String,
    pub address: String,
}

/// Sorted `.conf` entry names inside the archive at `path`.
pub fn entries(path: &Path) -> Result<Vec<String>, String> {
    let mut archive = open(path)?;
    let mut found = Vec::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|err| format!("Could not read {}: {err}", path.display()))?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name();
        if name.to_ascii_lowercase().ends_with(CONFIG_EXTENSION) {
            found.push(name.to_string());
        }
    }
    found.sort();
    if found.is_empty() {
        return Err(format!(
            "{} contains no .conf files. Download the Mullvad WireGuard config zip and try again.",
            path.display()
        ));
    }
    Ok(found)
}

/// Pick one config from the archive and parse its credentials.
///
/// Every `.conf` in a Mullvad download shares the same private key and
/// interface address, so the first entry in sorted order is as good as any.
/// Archives can contain hundreds of files; asking the user to choose is noise.
pub fn select_config(path: &Path) -> Result<(String, WireguardConfig), String> {
    let entries = entries(path)?;
    let entry = entries[0].clone();
    let config = load(path, &entry)?;
    Ok((entry, config))
}

/// Read and parse one `.conf` entry from the archive.
pub fn load(path: &Path, entry: &str) -> Result<WireguardConfig, String> {
    let mut archive = open(path)?;
    let mut file = archive
        .by_name(entry)
        .map_err(|err| format!("Could not read {entry} from {}: {err}", path.display()))?;
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|err| format!("Could not read {entry}: {err}"))?;
    parse(&text)
}

/// Extract `PrivateKey` and the IPv4 entry from an `Address` line.
pub fn parse(text: &str) -> Result<WireguardConfig, String> {
    let mut private_key = None;
    let mut addresses = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_lowercase().as_str() {
            "privatekey" => private_key = Some(value.trim().to_string()),
            "address" => addresses = Some(value.trim().to_string()),
            _ => {}
        }
    }

    let private_key =
        private_key.ok_or_else(|| "This config has no PrivateKey line.".to_string())?;
    validate_wireguard_key(&private_key)?;

    let addresses = addresses.ok_or_else(|| "This config has no Address line.".to_string())?;
    let address = addresses
        .split(',')
        .map(str::trim)
        .find(|candidate| {
            candidate
                .split('/')
                .next()
                .is_some_and(|ip| ip.parse::<Ipv4Addr>().is_ok())
        })
        .ok_or_else(|| "This config has no IPv4 Address entry.".to_string())?;
    validate_wireguard_address(address)?;

    Ok(WireguardConfig {
        private_key,
        address: address.to_string(),
    })
}

fn open(path: &Path) -> Result<ZipArchive<File>, String> {
    let file =
        File::open(path).map_err(|err| format!("Could not open {}: {err}", path.display()))?;
    ZipArchive::new(file)
        .map_err(|err| format!("{} is not a readable zip archive: {err}", path.display()))
}
