use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use churn::envfile;
use churn::jellyfin::{self, Credentials, Jellyfin};

struct Request {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or(&self.target)
    }
}

struct MockServer {
    base_url: String,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn mock_server(handler: impl Fn(&Request) -> (u16, String) + Send + 'static) -> MockServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
    listener.set_nonblocking(true).unwrap();
    let address: SocketAddr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = Arc::clone(&stop);

    let thread = thread::spawn(move || {
        while !stop_for_thread.load(Ordering::Relaxed) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    if let Some(request) = read_request(&mut stream) {
                        let (status, body) = handler(&request);
                        let _ = write_response(&mut stream, status, &body);
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => break,
            }
        }
    });

    MockServer {
        base_url: format!("http://{address}"),
        stop,
        thread: Some(thread),
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];

    let head_end = loop {
        if let Some(position) = find_bytes(&buffer, b"\r\n\r\n") {
            break position;
        }
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    };

    let head = String::from_utf8_lossy(&buffer[..head_end]).to_string();
    let content_length = header_value(&head, "content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body_start = head_end + 4;
    while buffer.len() < body_start + content_length {
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }

    let mut lines = head.lines();
    let mut request_line = lines.next()?.split_whitespace();
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect();
    let body = String::from_utf8_lossy(
        buffer
            .get(body_start..body_start + content_length)
            .unwrap_or_default(),
    )
    .to_string();

    Some(Request {
        method,
        target,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())?;
    stream.flush()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn header_value<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines()
        .skip(1)
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.trim())
}

fn temp_env(contents: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "churn-jellyfin-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(".env");
    fs::write(&path, contents).unwrap();
    (dir, path)
}

fn public_info(wizard_completed: bool) -> jellyfin::PublicInfo {
    jellyfin::PublicInfo {
        server_name: Some("churn".into()),
        version: Some("10.11.11".into()),
        startup_wizard_completed: wizard_completed,
    }
}

#[test]
fn fresh_install_creates_user_and_writes_api_key() {
    let saw_first_user_get = Arc::new(AtomicBool::new(false));
    let saw_first_user_get_for_handler = Arc::clone(&saw_first_user_get);
    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Startup/User") => {
                saw_first_user_get_for_handler.store(true, Ordering::Relaxed);
                (200, r#"{"Name":"root"}"#.into())
            }
            ("POST", "/Startup/User") => {
                assert!(request.body.contains("\"Name\":\"admin\""));
                assert!(request.body.contains("\"Password\":\"correct horse\""));
                (204, String::new())
            }
            ("POST", "/Startup/Configuration") => (204, String::new()),
            ("POST", "/Startup/RemoteAccess") => (204, String::new()),
            ("POST", "/Startup/Complete") => (204, String::new()),
            ("POST", "/Users/AuthenticateByName") => {
                assert!(request.header("authorization").is_some());
                (200, r#"{"AccessToken":"session-token"}"#.into())
            }
            ("GET", "/Auth/Keys") => (200, r#"{"Items":[]}"#.into()),
            ("POST", "/Auth/Keys") => {
                assert!(request.target.contains("app=churn"));
                (
                    200,
                    r#"{"AccessToken":"api-key-1","AppName":"churn","DateRevoked":null}"#.into(),
                )
            }
            ("GET", "/System/Info") => {
                assert_eq!(request.header("x-emby-token"), Some("api-key-1"));
                (200, r#"{"Version":"10.11.11"}"#.into())
            }
            _ => (404, "{}".into()),
        },
    );

    let (dir, env_path) = temp_env("DOWNLOAD_DIR=/data\nHAND_EDITED=keep-me\n");
    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let credentials = Credentials {
        username: "admin".into(),
        password: "correct horse".into(),
    };

    let result = client
        .provision(&env_path, &credentials, &public_info(false))
        .expect("provisioning should succeed");

    assert_eq!(result.api_key, "api-key-1");
    assert!(result.completed_setup);
    assert!(
        saw_first_user_get.load(Ordering::Relaxed),
        "Jellyfin initializes its first user on GET /Startup/User"
    );

    let env = envfile::read(&env_path);
    assert_eq!(
        env.get("JELLYFIN_API_KEY").map(String::as_str),
        Some("api-key-1")
    );
    assert_eq!(
        env.get("HAND_EDITED").map(String::as_str),
        Some("keep-me"),
        "hand-edited env values must survive provisioning"
    );

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn completed_setup_reuses_an_existing_churn_key() {
    let server = mock_server(|request| match (request.method.as_str(), request.path()) {
        ("POST", "/Users/AuthenticateByName") => (200, r#"{"AccessToken":"session-token"}"#.into()),
        ("GET", "/Auth/Keys") => (
            200,
            r#"{"Items":[{"AccessToken":"existing-key","AppName":"churn","DateRevoked":null}]}"#
                .into(),
        ),
        ("GET", "/System/Info") => {
            assert_eq!(request.header("x-emby-token"), Some("existing-key"));
            (200, r#"{"Version":"10.11.11"}"#.into())
        }
        _ => (404, "{}".into()),
    });

    let (dir, env_path) = temp_env("DOWNLOAD_DIR=/data\n");
    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let credentials = Credentials {
        username: "admin".into(),
        password: "correct horse".into(),
    };

    let result = client
        .provision(&env_path, &credentials, &public_info(true))
        .expect("provisioning should succeed");

    assert_eq!(result.api_key, "existing-key");
    assert!(!result.completed_setup);
    assert_eq!(
        envfile::read(&env_path)
            .get("JELLYFIN_API_KEY")
            .map(String::as_str),
        Some("existing-key")
    );

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn fallback_finds_key_after_a_204_create_response() {
    let list_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let list_calls_for_handler = Arc::clone(&list_calls);
    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("POST", "/Users/AuthenticateByName") => {
                (200, r#"{"AccessToken":"session-token"}"#.into())
            }
            ("GET", "/Auth/Keys") => {
                let call = list_calls_for_handler.fetch_add(1, Ordering::Relaxed);
                if call == 0 {
                    (200, r#"{"Items":[]}"#.into())
                } else {
                    (
                        200,
                        r#"{"Items":[{"AccessToken":"new-key","AppName":"churn","DateRevoked":null}]}"#
                            .into(),
                    )
                }
            }
            ("POST", "/Auth/Keys") => (204, String::new()),
            ("GET", "/System/Info") => {
                assert_eq!(request.header("x-emby-token"), Some("new-key"));
                (200, r#"{"Version":"10.11.11"}"#.into())
            }
            _ => (404, "{}".into()),
        },
    );

    let (dir, env_path) = temp_env("DOWNLOAD_DIR=/data\n");
    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let credentials = Credentials {
        username: "admin".into(),
        password: "correct horse".into(),
    };

    let result = client
        .provision(&env_path, &credentials, &public_info(true))
        .expect("provisioning should succeed");

    assert_eq!(result.api_key, "new-key");
    assert_eq!(list_calls.load(Ordering::Relaxed), 2);

    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_fresh_install_creates_one_mixed_library_at_the_media_root() {
    let created = Arc::new(std::sync::Mutex::new(Vec::new()));
    let created_for_handler = Arc::clone(&created);
    let refreshed = Arc::new(AtomicBool::new(false));
    let refreshed_for_handler = Arc::clone(&refreshed);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (200, "[]".into()),
            ("POST", "/Library/VirtualFolders") => {
                created_for_handler
                    .lock()
                    .unwrap()
                    .push(request.target.clone());
                (204, String::new())
            }
            ("POST", "/Library/Refresh") => {
                refreshed_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let changes = client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    let created = created.lock().unwrap();
    assert_eq!(created.len(), 1, "exactly one library, at the media root");
    assert!(created[0].contains("name=Media"));
    assert!(created[0].contains("paths=%2Fdata%2Fmedia"));
    assert!(
        !created[0].contains("collectionType"),
        "a mixed library omits the parameter entirely; an empty value is not the same"
    );
    assert!(refreshed.load(Ordering::Relaxed));
    assert_eq!(changes.len(), 1);
    assert!(changes[0].contains("created Jellyfin library Media at /data/media"));
}

#[test]
fn an_existing_library_covering_the_media_root_is_reused() {
    // A user library that already includes the media root, an ancestor of it,
    // or the root filesystem itself must be left completely alone: adding the
    // root again would nest one library inside another.
    for locations in [
        r#"["/data/media"]"#,
        r#"["/"]"#,
        r#"["/mnt/other","/data/media"]"#,
        // An install from before the split keeps one library per media folder.
        // A root library around them would nest, which Jellyfin rejects.
        r#"["/data/media/movies"]"#,
        r#"["/data/media/tv"]"#,
    ] {
        let touched = Arc::new(AtomicBool::new(false));
        let touched_for_handler = Arc::clone(&touched);
        let body = format!(r#"[{{"Name":"My library","Locations":{locations}}}]"#);

        let server = mock_server(
            move |request| match (request.method.as_str(), request.path()) {
                ("GET", "/Library/VirtualFolders") => (200, body.clone()),
                ("POST", _) | ("DELETE", _) => {
                    touched_for_handler.store(true, Ordering::Relaxed);
                    (204, String::new())
                }
                _ => (404, "{}".into()),
            },
        );

        let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
        let changes = client
            .ensure_libraries("api-key")
            .expect("library check should succeed");

        assert!(
            !touched.load(Ordering::Relaxed),
            "a library covering {locations} must not be changed"
        );
        assert!(changes.is_empty(), "nothing to report for {locations}");
    }
}

/// The upgrade path: a pre-split install has two typed libraries under the
/// media root. Creating a mixed library at the root would overlap both.
#[test]
fn a_pre_split_install_with_two_libraries_gains_no_root_library() {
    let touched = Arc::new(AtomicBool::new(false));
    let touched_for_handler = Arc::clone(&touched);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[
                {"Name":"Movies","Locations":["/data/media/movies"],"CollectionType":"movies"},
                {"Name":"Shows","Locations":["/data/media/tv"],"CollectionType":"tvshows"}
            ]"#
                .into(),
            ),
            ("POST", _) | ("DELETE", _) => {
                touched_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let changes = client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    assert!(
        !touched.load(Ordering::Relaxed),
        "a root library must not be created around the existing typed ones"
    );
    assert!(changes.is_empty());
}

#[test]
fn a_library_elsewhere_is_left_alone_and_ours_is_created_alongside() {
    let created = Arc::new(AtomicBool::new(false));
    let created_for_handler = Arc::clone(&created);
    let deleted = Arc::new(AtomicBool::new(false));
    let deleted_for_handler = Arc::clone(&deleted);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[{"Name":"Films","Locations":["/mnt/other"]}]"#.into(),
            ),
            ("POST", "/Library/VirtualFolders") => {
                created_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            ("DELETE", _) => {
                deleted_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            ("POST", "/Library/Refresh") => (204, String::new()),
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let changes = client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    assert!(created.load(Ordering::Relaxed));
    assert!(
        !deleted.load(Ordering::Relaxed),
        "the user's library is kept"
    );
    assert_eq!(changes.len(), 1);
}

#[test]
fn a_library_pointing_at_the_download_root_is_still_removed() {
    let removed = Arc::new(AtomicBool::new(false));
    let removed_for_handler = Arc::clone(&removed);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[{"Name":"Media","Locations":["/data"],"ItemId":"media-id"}]"#.into(),
            ),
            ("DELETE", "/Library/VirtualFolders/Paths") => {
                assert!(request.target.contains("name=Media"));
                assert!(request.target.contains("path=%2Fdata"));
                removed_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            ("POST", "/Library/Refresh") => (204, String::new()),
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let changes = client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    assert!(removed.load(Ordering::Relaxed));
    assert!(
        changes
            .iter()
            .any(|change| change.contains("removed /data from Jellyfin library Media"))
    );
}

#[test]
fn library_setup_is_a_noop_when_the_media_root_is_already_covered() {
    let server = mock_server(|request| match (request.method.as_str(), request.path()) {
        ("GET", "/Library/VirtualFolders") => (
            200,
            r#"[{"Name":"Media","Locations":["/data/media"],"ItemId":"media-id"}]"#.into(),
        ),
        _ => (404, "{}".into()),
    });

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    assert!(
        client
            .ensure_libraries("api-key")
            .expect("library check should succeed")
            .is_empty()
    );
}

#[test]
fn real_time_monitoring_is_enabled_on_the_media_library() {
    let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let updates_for_handler = Arc::clone(&updates);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[
                {
                    "Name":"Media",
                    "Locations":["/data/media"],
                    "ItemId":"media-id",
                    "LibraryOptions":{"EnableRealtimeMonitor":false,"SaveLocalMetadata":false}
                }
            ]"#
                .into(),
            ),
            ("POST", "/Library/VirtualFolders/LibraryOptions") => {
                updates_for_handler
                    .lock()
                    .unwrap()
                    .push(request.body.clone());
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    let changes = client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    let updates = updates.lock().unwrap();
    assert_eq!(updates.len(), 1);
    let body: serde_json::Value = serde_json::from_str(&updates[0]).expect("json body");
    assert_eq!(body["Id"], "media-id");
    assert_eq!(body["LibraryOptions"]["EnableRealtimeMonitor"], true);
    assert_eq!(
        body["LibraryOptions"]["SaveLocalMetadata"], false,
        "the other library options must round-trip unchanged"
    );
    assert_eq!(changes.len(), 1);
    assert!(
        changes
            .iter()
            .any(|change| change.contains("real-time monitoring") && change.contains("Media"))
    );
}

/// Before the split there were two libraries, and both still need monitoring.
#[test]
fn real_time_monitoring_reaches_every_library_under_the_media_root() {
    let updates = Arc::new(std::sync::Mutex::new(Vec::new()));
    let updates_for_handler = Arc::clone(&updates);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[
                {
                    "Name":"Movies",
                    "Locations":["/data/media/movies"],
                    "ItemId":"movies-id",
                    "LibraryOptions":{"EnableRealtimeMonitor":false}
                },
                {
                    "Name":"Shows",
                    "Locations":["/data/media/tv"],
                    "ItemId":"shows-id",
                    "LibraryOptions":{"EnableRealtimeMonitor":false}
                }
            ]"#
                .into(),
            ),
            ("POST", "/Library/VirtualFolders/LibraryOptions") => {
                updates_for_handler
                    .lock()
                    .unwrap()
                    .push(request.body.clone());
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    client
        .ensure_libraries("api-key")
        .expect("library setup should succeed");

    let updates = updates.lock().unwrap();
    assert_eq!(updates.len(), 2, "both libraries are imported into");
    let ids: Vec<String> = updates
        .iter()
        .map(|body| {
            let value: serde_json::Value = serde_json::from_str(body).expect("json body");
            value["Id"].as_str().unwrap().to_string()
        })
        .collect();
    assert!(ids.contains(&"movies-id".to_string()));
    assert!(ids.contains(&"shows-id".to_string()));
}

#[test]
fn tailnet_subnets_are_added_without_losing_network_config() {
    let posted = Arc::new(std::sync::Mutex::new(None));
    let posted_for_handler = Arc::clone(&posted);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/System/Configuration/Network") => {
                assert_eq!(request.header("x-emby-token"), Some("api-key"));
                (
                    200,
                    r#"{
                        "BaseUrl":"/jellyfin",
                        "EnableRemoteAccess":false,
                        "EnableIPv6":true,
                        "LocalNetworkSubnets":["192.168.0.0/24"],
                        "LocalNetworkAddresses":[],
                        "KnownProxies":[]
                    }"#
                    .into(),
                )
            }
            ("POST", "/System/Configuration/Network") => {
                *posted_for_handler.lock().unwrap() = Some(request.body.clone());
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    assert!(
        client
            .ensure_tailnet_access("api-key")
            .expect("tailnet setup should succeed")
    );

    let body: serde_json::Value = serde_json::from_str(
        posted
            .lock()
            .unwrap()
            .as_deref()
            .expect("network config was posted"),
    )
    .expect("json body");
    assert_eq!(body["BaseUrl"], "/jellyfin");
    assert_eq!(body["EnableRemoteAccess"], false);
    assert_eq!(body["EnableIPv6"], true);
    let subnets = body["LocalNetworkSubnets"]
        .as_array()
        .expect("subnets array");
    let subnets: Vec<&str> = subnets
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect();
    assert!(subnets.contains(&"192.168.0.0/24"));
    assert!(subnets.contains(&"192.168.0.0/16"));
    assert!(subnets.contains(&"100.64.0.0/10"));
    assert!(subnets.contains(&"fd7a:115c:a1e0::/48"));
}

#[test]
fn tailnet_setup_is_a_noop_when_the_subnets_are_already_present() {
    let posted = Arc::new(AtomicBool::new(false));
    let posted_for_handler = Arc::clone(&posted);

    let server = mock_server(move |request| {
        match (request.method.as_str(), request.path()) {
            ("GET", "/System/Configuration/Network") => (
                200,
                r#"{
                    "LocalNetworkSubnets":["127.0.0.0/8","10.0.0.0/8","172.16.0.0/12","192.168.0.0/16","169.254.0.0/16","100.64.0.0/10","::1/128","fc00::/7","fe80::/10","fd7a:115c:a1e0::/48"]
                }"#
                .into(),
            ),
            ("POST", "/System/Configuration/Network") => {
                posted_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            _ => (404, "{}".into()),
        }
    });

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    assert!(
        !client
            .ensure_tailnet_access("api-key")
            .expect("tailnet check should succeed")
    );
    assert!(!posted.load(Ordering::Relaxed));
}

#[test]
fn restart_waits_until_jellyfin_is_serving_again() {
    let restarted = Arc::new(AtomicBool::new(false));
    let down_polls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let restarted_for_handler = Arc::clone(&restarted);
    let down_polls_for_handler = Arc::clone(&down_polls);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/System/Info/Public") => {
                if !restarted_for_handler.load(Ordering::Relaxed) {
                    return (200, r#"{"StartupWizardCompleted":true}"#.into());
                }
                let poll = down_polls_for_handler.fetch_add(1, Ordering::Relaxed);
                if poll < 2 {
                    (503, String::new())
                } else {
                    (200, r#"{"StartupWizardCompleted":true}"#.into())
                }
            }
            ("POST", "/System/Restart") => {
                assert_eq!(request.header("x-emby-token"), Some("api-key"));
                restarted_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            _ => (404, "{}".into()),
        },
    );

    let client = Jellyfin::new(&server.base_url, Duration::from_secs(2));
    client
        .restart_and_wait("api-key", Duration::from_secs(5))
        .expect("restart should wait for the new process");
    assert!(restarted.load(Ordering::Relaxed));
}
