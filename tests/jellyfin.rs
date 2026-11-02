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

    let (dir, env_path) = temp_env("DATA_DIR=/data\nHAND_EDITED=keep-me\n");
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

    let (dir, env_path) = temp_env("DATA_DIR=/data\n");
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

    let (dir, env_path) = temp_env("DATA_DIR=/data\n");
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
fn libraries_are_created_at_the_media_root_and_data_root_is_removed() {
    let added_movie_path = Arc::new(AtomicBool::new(false));
    let created_shows = Arc::new(AtomicBool::new(false));
    let removed_data_root = Arc::new(AtomicBool::new(false));
    let refreshed = Arc::new(AtomicBool::new(false));

    let added_movie_path_for_handler = Arc::clone(&added_movie_path);
    let created_shows_for_handler = Arc::clone(&created_shows);
    let removed_data_root_for_handler = Arc::clone(&removed_data_root);
    let refreshed_for_handler = Arc::clone(&refreshed);

    let server = mock_server(
        move |request| match (request.method.as_str(), request.path()) {
            ("GET", "/Library/VirtualFolders") => (
                200,
                r#"[{"Name":"Movies","Locations":["/data"],"CollectionType":"movies"}]"#.into(),
            ),
            ("POST", "/Library/VirtualFolders/Paths") => {
                assert!(request.body.contains("/data/media/movies"));
                added_movie_path_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            ("POST", "/Library/VirtualFolders") => {
                assert!(request.target.contains("name=Shows"));
                assert!(request.target.contains("collectionType=tvshows"));
                assert!(request.target.contains("paths=%2Fdata%2Fmedia%2Ftv"));
                created_shows_for_handler.store(true, Ordering::Relaxed);
                (204, String::new())
            }
            ("DELETE", "/Library/VirtualFolders/Paths") => {
                assert!(request.target.contains("name=Movies"));
                assert!(request.target.contains("path=%2Fdata"));
                removed_data_root_for_handler.store(true, Ordering::Relaxed);
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

    assert!(added_movie_path.load(Ordering::Relaxed));
    assert!(created_shows.load(Ordering::Relaxed));
    assert!(removed_data_root.load(Ordering::Relaxed));
    assert!(refreshed.load(Ordering::Relaxed));
    assert_eq!(changes.len(), 3);
    assert!(
        changes
            .iter()
            .any(|change| change.contains("created Jellyfin library Shows"))
    );
    assert!(
        changes
            .iter()
            .any(|change| change.contains("removed /data from Jellyfin library Movies"))
    );
}

#[test]
fn library_setup_is_a_noop_when_media_paths_are_already_correct() {
    let server = mock_server(|request| match (request.method.as_str(), request.path()) {
        ("GET", "/Library/VirtualFolders") => (
            200,
            r#"[
                {"Name":"Movies","Locations":["/data/media/movies"],"CollectionType":"movies"},
                {"Name":"Shows","Locations":["/data/media/tv"],"CollectionType":"tvshows"}
            ]"#
            .into(),
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
fn real_time_monitoring_is_enabled_on_the_media_libraries() {
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
                    "CollectionType":"movies",
                    "ItemId":"movies-id",
                    "LibraryOptions":{"EnableRealtimeMonitor":false,"SaveLocalMetadata":false}
                },
                {
                    "Name":"Shows",
                    "Locations":["/data/media/tv"],
                    "CollectionType":"tvshows",
                    "ItemId":"shows-id",
                    "LibraryOptions":{"EnableRealtimeMonitor":true,"SaveLocalMetadata":true}
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
    assert_eq!(
        updates.len(),
        1,
        "only the library without monitoring is updated"
    );
    let body: serde_json::Value = serde_json::from_str(&updates[0]).expect("json body");
    assert_eq!(body["Id"], "movies-id");
    assert_eq!(body["LibraryOptions"]["EnableRealtimeMonitor"], true);
    assert_eq!(
        body["LibraryOptions"]["SaveLocalMetadata"], false,
        "the other library options must round-trip unchanged"
    );
    assert_eq!(changes.len(), 1);
    assert!(
        changes
            .iter()
            .any(|change| change.contains("real-time monitoring") && change.contains("Movies"))
    );
}
