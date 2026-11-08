//! Jellyfin first-run setup and API-key provisioning.
//!
//! Churn runs this after the server stack has started. On a fresh install it
//! creates the first admin user, completes the startup wizard, authenticates,
//! creates a long-lived API key and writes that key to `server/.env`.

use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::envfile;

pub const API_KEY_ENV: &str = "JELLYFIN_API_KEY";
const API_KEY_NAME: &str = "churn";
/// Jellyfin runs with the same download directory mounted at /data as the other
/// stacks.
const DATA_ROOT: &str = "/data";
/// Media libraries must point at the media folders, never at DATA_ROOT: the
/// download clients save under /data, so a root-level library indexes files
/// that are still downloading.
const MEDIA_LIBRARIES: &[(&str, &str, &str)] = &[
    ("Movies", "movies", "/data/media/movies"),
    ("Shows", "tvshows", "/data/media/tv"),
];
/// Jellyfin replaces its default "all private networks are local" rule as soon
/// as `LocalNetworkSubnets` is non-empty. Keep the private ranges explicitly so
/// LAN, loopback and Docker clients still work, then add the reserved Tailscale
/// ranges so tailnet clients can play video while remote access stays off.
const LOCAL_NETWORK_SUBNETS: &[&str] = &[
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
    "100.64.0.0/10",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
    "fd7a:115c:a1e0::/48",
];

const AUTH_HEADER: &str = concat!(
    "MediaBrowser Client=\"churn\", Device=\"installer\", ",
    "DeviceId=\"churn-installer\", Version=\"0.1.0\""
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Provisioned {
    pub api_key: String,
    pub completed_setup: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "PascalCase")]
pub struct PublicInfo {
    pub server_name: Option<String>,
    pub version: Option<String>,
    #[serde(default)]
    pub startup_wizard_completed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AuthenticationResult {
    access_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ApiKeyInfo {
    access_token: Option<String>,
    app_name: Option<String>,
    date_created: Option<String>,
    date_revoked: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ApiKeyList {
    #[serde(default)]
    items: Vec<ApiKeyInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct VirtualFolderInfo {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    locations: Option<Vec<String>>,
    #[serde(default)]
    collection_type: Option<String>,
    #[serde(default)]
    item_id: Option<String>,
    /// Jellyfin's full `LibraryOptions`. Kept as raw JSON because the update
    /// endpoint replaces the whole object: every field churn does not know
    /// about has to round-trip unchanged.
    #[serde(default)]
    library_options: Option<serde_json::Value>,
}

struct HttpResponse {
    status: u16,
    body: String,
}

/// Client for the small subset of Jellyfin's API needed by the installer.
pub struct Jellyfin {
    base_url: String,
    timeout: Duration,
}

impl Jellyfin {
    pub fn new(base_url: impl Into<String>, timeout: Duration) -> Self {
        let mut base_url = base_url.into().trim().trim_end_matches('/').to_string();
        if !base_url.contains("://") {
            base_url = format!("http://{base_url}");
        }
        Self { base_url, timeout }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Poll until Jellyfin's public API responds, or `wait` expires.
    pub fn wait_until_ready(&self, wait: Duration) -> io::Result<PublicInfo> {
        let started = Instant::now();
        loop {
            let last_error = match self.public_info() {
                Ok(info) => return Ok(info),
                Err(err) => err.to_string(),
            };
            if started.elapsed() >= wait {
                return Err(io::Error::other(format!(
                    "Jellyfin did not become ready within {}s: {last_error}",
                    wait.as_secs()
                )));
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }

    pub fn public_info(&self) -> io::Result<PublicInfo> {
        let response = self.send(ureq::get(&format!("{}/System/Info/Public", self.base_url)))?;
        if response.status != 200 {
            return Err(http_error("read Jellyfin public info", &response));
        }
        decode(&response, "Jellyfin public info")
    }

    /// Restart Jellyfin and wait until a fresh process answers again.
    ///
    /// Network settings such as `LocalNetworkSubnets` are only applied on
    /// startup, so churn restarts Jellyfin after changing them. The wait needs
    /// to see the server go down first; otherwise the old process could answer
    /// before it has actually restarted.
    pub fn restart_and_wait(&self, api_key: &str, wait: Duration) -> io::Result<()> {
        let response = self.send(
            ureq::post(&format!("{}/System/Restart", self.base_url)).set("X-Emby-Token", api_key),
        )?;
        expect_no_content(response, "restart Jellyfin")?;

        let started = Instant::now();
        let mut saw_down = false;
        loop {
            match self.public_info() {
                Ok(_) if saw_down => return Ok(()),
                Ok(_) => {}
                Err(_) => saw_down = true,
            }
            if started.elapsed() >= wait {
                return Err(io::Error::other(format!(
                    "Jellyfin did not finish restarting within {}s",
                    wait.as_secs()
                )));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// True when Jellyfin accepts the key for an elevated system-info request.
    pub fn validate_api_key(&self, key: &str) -> io::Result<bool> {
        let response = self
            .send(ureq::get(&format!("{}/System/Info", self.base_url)).set("X-Emby-Token", key))?;
        match response.status {
            200 => Ok(true),
            401 | 403 => Ok(false),
            _ => Err(http_error("validate Jellyfin API key", &response)),
        }
    }

    /// Complete first-run setup if needed, authenticate, create/reuse an API
    /// key, and write it into `server/.env`.
    pub fn provision(
        &self,
        env_path: &Path,
        credentials: &Credentials,
        public: &PublicInfo,
    ) -> io::Result<Provisioned> {
        let completed_setup = !public.startup_wizard_completed;
        if completed_setup {
            self.configure_startup(credentials)?;
        }

        let token = self.authenticate(credentials)?;
        let api_key = self.ensure_api_key(&token)?;
        if !self.validate_api_key(&api_key)? {
            return Err(io::Error::other(
                "Jellyfin created an API key but rejected it; check the Jellyfin logs",
            ));
        }
        envfile::upsert(env_path, API_KEY_ENV, &api_key)?;
        Ok(Provisioned {
            api_key,
            completed_setup,
        })
    }

    fn configure_startup(&self, credentials: &Credentials) -> io::Result<()> {
        // Jellyfin only creates its initial user lazily on GET /Startup/User.
        // POST /Startup/User returns 404 when that has never happened, so ask
        // for the first user before trying to rename it and set a password.
        let first_user = self.send(ureq::get(&format!("{}/Startup/User", self.base_url)))?;
        if first_user.status != 200 {
            return Err(http_error(
                "initialise the Jellyfin admin user",
                &first_user,
            ));
        }

        let response = self.send_json(
            ureq::post(&format!("{}/Startup/User", self.base_url)),
            json!({
                "Name": credentials.username,
                "Password": credentials.password,
            }),
        )?;
        // A rerun after the user was configured but the wizard was not
        // completed returns 403. Authentication below still tells us whether
        // the supplied password is the right one.
        if response.status != 204 && response.status != 403 {
            return Err(http_error("set the Jellyfin admin user", &response));
        }

        expect_no_content(
            self.send_json(
                ureq::post(&format!("{}/Startup/Configuration", self.base_url)),
                json!({
                    "ServerName": "churn",
                    "UICulture": "en-US",
                    "MetadataCountryCode": "US",
                    "PreferredMetadataLanguage": "en",
                }),
            )?,
            "configure Jellyfin",
        )?;

        expect_no_content(
            self.send_json(
                ureq::post(&format!("{}/Startup/RemoteAccess", self.base_url)),
                json!({
                    "EnableRemoteAccess": false,
                    "EnableAutomaticPortMapping": false,
                }),
            )?,
            "configure Jellyfin remote access",
        )?;

        expect_no_content(
            self.send(ureq::post(&format!("{}/Startup/Complete", self.base_url)))?,
            "complete Jellyfin setup",
        )
    }

    fn authenticate(&self, credentials: &Credentials) -> io::Result<String> {
        let response = self.send_json(
            ureq::post(&format!("{}/Users/AuthenticateByName", self.base_url))
                .set("Authorization", AUTH_HEADER),
            json!({
                "Username": credentials.username,
                "Pw": credentials.password,
            }),
        )?;
        if response.status != 200 {
            let hint = if response.status == 401 {
                " — check the Jellyfin admin username and password"
            } else {
                ""
            };
            return Err(io::Error::other(format!(
                "authenticate with Jellyfin failed (HTTP {}){hint}: {}",
                response.status,
                response.body.trim()
            )));
        }
        let result: AuthenticationResult = decode(&response, "Jellyfin authentication response")?;
        result.access_token.ok_or_else(|| {
            io::Error::other("Jellyfin authenticated the user but returned no access token")
        })
    }

    fn ensure_api_key(&self, token: &str) -> io::Result<String> {
        if let Some(key) = self.list_api_keys(token)?.into_iter().find_map(usable_key) {
            return Ok(key);
        }

        let response = self.send(
            ureq::post(&format!("{}/Auth/Keys", self.base_url))
                .query("app", API_KEY_NAME)
                .set("X-Emby-Token", token),
        )?;
        if response.status == 200 {
            let created: ApiKeyInfo = decode(&response, "Jellyfin API key response")?;
            if let Some(key) = usable_key(created) {
                return Ok(key);
            }
        } else if response.status != 204 {
            return Err(http_error("create a Jellyfin API key", &response));
        }

        // Jellyfin 10.11 returns 204 from this endpoint while newer builds
        // return the created key as JSON. If the body did not contain it,
        // reload the list and take the newest matching key.
        let mut keys: Vec<ApiKeyInfo> = self
            .list_api_keys(token)?
            .into_iter()
            .filter(|key| is_usable(key) && key_name_matches(key))
            .collect();
        keys.sort_by(|a, b| a.date_created.cmp(&b.date_created));
        keys.pop()
            .and_then(usable_key)
            .ok_or_else(|| io::Error::other("Jellyfin created an API key but did not return it"))
    }

    /// Create the movie and TV libraries at the media root and remove any
    /// library path that points at DATA_ROOT itself. Download clients save
    /// under DATA_ROOT, so a root-level library makes Jellyfin index files that
    /// are still downloading.
    pub fn ensure_libraries(&self, api_key: &str) -> io::Result<Vec<String>> {
        let folders = self.list_virtual_folders(api_key)?;
        let mut changes = Vec::new();

        for (name, collection_type, path) in MEDIA_LIBRARIES {
            let existing = folders.iter().find(|folder| {
                folder
                    .collection_type
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(collection_type))
                    || folder
                        .name
                        .as_deref()
                        .is_some_and(|value| value.eq_ignore_ascii_case(name))
            });

            match existing {
                None => {
                    self.add_virtual_folder(api_key, name, collection_type, path)?;
                    changes.push(format!("created Jellyfin library {name} at {path}"));
                }
                Some(folder) => {
                    let folder_name = folder.name.as_deref().unwrap_or(name);
                    let locations = folder.locations.as_deref().unwrap_or_default();
                    if !locations
                        .iter()
                        .any(|location| normalize_path(location) == normalize_path(path))
                    {
                        self.add_media_path(api_key, folder_name, path)?;
                        changes.push(format!("added {path} to Jellyfin library {folder_name}"));
                    }
                }
            }
        }

        for folder in &folders {
            let Some(folder_name) = folder.name.as_deref() else {
                continue;
            };
            for location in folder.locations.as_deref().unwrap_or_default() {
                if normalize_path(location) == normalize_path(DATA_ROOT) {
                    self.remove_media_path(api_key, folder_name, location)?;
                    changes.push(format!(
                        "removed {location} from Jellyfin library {folder_name} (downloads must not be indexed)"
                    ));
                }
            }
        }

        if !changes.is_empty() {
            self.refresh_library(api_key)?;
        }

        // Re-read the folders so libraries just created above are included.
        let folders = self.list_virtual_folders(api_key)?;
        for (name, collection_type, _) in MEDIA_LIBRARIES {
            let Some(folder) = folders.iter().find(|folder| {
                folder
                    .collection_type
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(collection_type))
                    || folder
                        .name
                        .as_deref()
                        .is_some_and(|value| value.eq_ignore_ascii_case(name))
            }) else {
                continue;
            };
            if self.enable_realtime_monitoring(api_key, folder)? {
                changes.push(format!(
                    "enabled real-time monitoring for Jellyfin library {}",
                    folder.name.as_deref().unwrap_or(name)
                ));
            }
        }

        Ok(changes)
    }

    /// Allow tailnet clients to reach Jellyfin while remote access stays off.
    ///
    /// Jellyfin's access middleware rejects every non-local address when
    /// `EnableRemoteAccess` is false. Tailscale uses the reserved CGNAT range,
    /// which Jellyfin does not consider local by default, so add it (together
    /// with the private LAN ranges Jellyfin otherwise detects automatically) to
    /// `LocalNetworkSubnets`. The rest of the network configuration is sent
    /// back unchanged. Jellyfin applies this on startup, so the caller restarts
    /// it after a change.
    pub fn ensure_tailnet_access(&self, api_key: &str) -> io::Result<bool> {
        let response = self.send(
            ureq::get(&format!("{}/System/Configuration/Network", self.base_url))
                .set("X-Emby-Token", api_key),
        )?;
        if response.status != 200 {
            return Err(http_error("read Jellyfin network configuration", &response));
        }

        let mut config: serde_json::Value = decode(&response, "Jellyfin network configuration")?;
        let Some(object) = config.as_object_mut() else {
            return Err(io::Error::other(
                "Jellyfin returned a non-object network configuration",
            ));
        };
        let subnets = object
            .entry("LocalNetworkSubnets")
            .or_insert_with(|| json!([]));
        let Some(subnets) = subnets.as_array_mut() else {
            return Err(io::Error::other(
                "Jellyfin returned a non-array LocalNetworkSubnets value",
            ));
        };

        let mut changed = false;
        for subnet in LOCAL_NETWORK_SUBNETS {
            if !subnets.iter().any(|value| {
                value
                    .as_str()
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case(subnet))
            }) {
                subnets.push(json!(subnet));
                changed = true;
            }
        }
        if !changed {
            return Ok(false);
        }

        expect_no_content(
            self.send_json(
                ureq::post(&format!("{}/System/Configuration/Network", self.base_url))
                    .set("X-Emby-Token", api_key),
                config,
            )?,
            "allow Tailscale clients in Jellyfin",
        )?;
        Ok(true)
    }

    /// Let Jellyfin watch the media folders itself. Churn still asks for a scan
    /// after an import, but a scan that starts too early finds nothing; real-time
    /// monitoring makes the library catch up without another churn scan.
    fn enable_realtime_monitoring(
        &self,
        api_key: &str,
        folder: &VirtualFolderInfo,
    ) -> io::Result<bool> {
        let (Some(item_id), Some(options)) = (folder.item_id.as_deref(), &folder.library_options)
        else {
            return Ok(false);
        };
        if options
            .get("EnableRealtimeMonitor")
            .and_then(|v| v.as_bool())
            == Some(true)
        {
            return Ok(false);
        }

        let mut updated = options.clone();
        updated["EnableRealtimeMonitor"] = json!(true);
        expect_no_content(
            self.send_json(
                ureq::post(&format!(
                    "{}/Library/VirtualFolders/LibraryOptions",
                    self.base_url
                ))
                .set("X-Emby-Token", api_key),
                json!({ "Id": item_id, "LibraryOptions": updated }),
            )?,
            "enable Jellyfin real-time library monitoring",
        )?;
        Ok(true)
    }

    fn list_virtual_folders(&self, api_key: &str) -> io::Result<Vec<VirtualFolderInfo>> {
        let response = self.send(
            ureq::get(&format!("{}/Library/VirtualFolders", self.base_url))
                .set("X-Emby-Token", api_key),
        )?;
        if response.status != 200 {
            return Err(http_error("list Jellyfin libraries", &response));
        }
        decode(&response, "Jellyfin library list")
    }

    fn add_virtual_folder(
        &self,
        api_key: &str,
        name: &str,
        collection_type: &str,
        path: &str,
    ) -> io::Result<()> {
        let response = self.send_json(
            ureq::post(&format!("{}/Library/VirtualFolders", self.base_url))
                .query("name", name)
                .query("collectionType", collection_type)
                .query("paths", path)
                .query("refreshLibrary", "false")
                .set("X-Emby-Token", api_key),
            json!({}),
        )?;
        expect_no_content(response, "create a Jellyfin library")
    }

    fn add_media_path(&self, api_key: &str, name: &str, path: &str) -> io::Result<()> {
        let response = self.send_json(
            ureq::post(&format!("{}/Library/VirtualFolders/Paths", self.base_url))
                .query("refreshLibrary", "false")
                .set("X-Emby-Token", api_key),
            json!({ "Name": name, "PathInfo": { "Path": path } }),
        )?;
        expect_no_content(response, "add a Jellyfin library path")
    }

    fn remove_media_path(&self, api_key: &str, name: &str, path: &str) -> io::Result<()> {
        let response = self.send(
            ureq::request(
                "DELETE",
                &format!("{}/Library/VirtualFolders/Paths", self.base_url),
            )
            .query("name", name)
            .query("path", path)
            .query("refreshLibrary", "false")
            .set("X-Emby-Token", api_key),
        )?;
        expect_no_content(response, "remove a Jellyfin library path")
    }

    fn refresh_library(&self, api_key: &str) -> io::Result<()> {
        let response = self.send(
            ureq::post(&format!("{}/Library/Refresh", self.base_url)).set("X-Emby-Token", api_key),
        )?;
        expect_no_content(response, "refresh the Jellyfin library")
    }

    fn list_api_keys(&self, token: &str) -> io::Result<Vec<ApiKeyInfo>> {
        let response = self
            .send(ureq::get(&format!("{}/Auth/Keys", self.base_url)).set("X-Emby-Token", token))?;
        if response.status != 200 {
            return Err(http_error("list Jellyfin API keys", &response));
        }
        let list: ApiKeyList = decode(&response, "Jellyfin API key list")?;
        Ok(list.items)
    }

    fn send(&self, request: ureq::Request) -> io::Result<HttpResponse> {
        self.send_result(request.timeout(self.timeout).call())
    }

    fn send_json(&self, request: ureq::Request, data: impl Serialize) -> io::Result<HttpResponse> {
        self.send_result(request.timeout(self.timeout).send_json(data))
    }

    fn send_result(&self, result: Result<ureq::Response, ureq::Error>) -> io::Result<HttpResponse> {
        match result {
            Ok(response) => {
                let status = response.status();
                let body = response
                    .into_string()
                    .map_err(|err| io::Error::other(format!("read Jellyfin response: {err}")))?;
                Ok(HttpResponse { status, body })
            }
            Err(ureq::Error::Status(status, response)) => {
                let body = response.into_string().unwrap_or_default();
                Ok(HttpResponse { status, body })
            }
            Err(ureq::Error::Transport(err)) => Err(io::Error::other(format!(
                "could not reach Jellyfin at {}: {err}",
                self.base_url
            ))),
        }
    }
}

fn normalize_path(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() { "/" } else { trimmed }
}

fn usable_key(info: ApiKeyInfo) -> Option<String> {
    (is_usable(&info) && key_name_matches(&info))
        .then_some(info.access_token)
        .flatten()
        .filter(|key| !key.is_empty())
}

fn is_usable(info: &ApiKeyInfo) -> bool {
    info.date_revoked.is_none()
}

fn key_name_matches(info: &ApiKeyInfo) -> bool {
    info.app_name
        .as_deref()
        .is_some_and(|name| name.eq_ignore_ascii_case(API_KEY_NAME))
}

fn expect_no_content(response: HttpResponse, action: &str) -> io::Result<()> {
    if matches!(response.status, 200 | 204) {
        return Ok(());
    }
    Err(http_error(action, &response))
}

fn decode<T: DeserializeOwned>(response: &HttpResponse, what: &str) -> io::Result<T> {
    serde_json::from_str(&response.body).map_err(|err| {
        io::Error::other(format!(
            "{what} was not valid JSON: {err}; body: {}",
            truncate(&response.body)
        ))
    })
}

fn http_error(action: &str, response: &HttpResponse) -> io::Error {
    io::Error::other(format!(
        "{action} failed (HTTP {}): {}",
        response.status,
        truncate(&response.body)
    ))
}

fn truncate(body: &str) -> String {
    const LIMIT: usize = 400;
    let body = body.trim();
    if body.chars().count() <= LIMIT {
        return body.to_string();
    }
    let truncated: String = body.chars().take(LIMIT).collect();
    format!("{truncated}…")
}

pub fn validate_username(value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("A Jellyfin admin username is required.".into());
    }
    if value.len() > 64 {
        return Err("Keep the username to 64 characters or fewer.".into());
    }
    if value.contains(['/', '\\', ':']) {
        return Err("The username cannot contain /, \\ or :.".into());
    }
    Ok(())
}

pub fn validate_password(value: &str) -> Result<(), String> {
    if value.chars().count() < 8 {
        return Err("Use at least 8 characters for the Jellyfin admin password.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames_are_checked() {
        assert!(validate_username("admin").is_ok());
        assert!(validate_username("  ").is_err());
        assert!(validate_username("bad/name").is_err());
        assert!(validate_username("bad:name").is_err());
    }

    #[test]
    fn passwords_have_a_minimum_length() {
        assert!(validate_password("12345678").is_ok());
        assert!(validate_password("short").is_err());
    }

    #[test]
    fn urls_get_a_scheme_and_lose_trailing_slashes() {
        let client = Jellyfin::new("127.0.0.1:8096/", Duration::from_secs(1));
        assert_eq!(client.base_url(), "http://127.0.0.1:8096");
        let client = Jellyfin::new("https://media.example/", Duration::from_secs(1));
        assert_eq!(client.base_url(), "https://media.example");
    }
}
