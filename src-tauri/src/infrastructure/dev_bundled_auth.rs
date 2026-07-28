//! Development-only bridge for importing the installed app's ORG2 Cloud login.
//!
//! On macOS, WebKit isolates `tauri://localhost` (bundled builds) from the
//! HTTP origin used by `tauri dev`. This bridge deliberately exposes one
//! allow-listed localStorage key and validates its shape before returning it.

#[cfg(target_os = "macos")]
use rusqlite::{types::ValueRef, Connection, OpenFlags, OptionalExtension};
#[cfg(target_os = "macos")]
use serde::Deserialize;
#[cfg(target_os = "macos")]
use std::{
    cmp::Ordering,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[cfg(target_os = "macos")]
const ORG2_CLOUD_AUTH_STORAGE_KEY: &str = "orgii:org2-cloud-v1:auth";

/// Import the installed app's ORG2 Cloud auth record into a development UI.
///
/// The command is rejected in release builds. On macOS it inspects only the
/// current bundle identifier's WebKit data, only the `tauri://localhost`
/// origin, and only the fixed ORG2 Cloud auth key.
#[tauri::command]
pub async fn debug_import_bundled_org2_cloud_auth(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    if !cfg!(debug_assertions) {
        return Err("bundled auth import is available only in development builds".to_string());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("bundled auth import is currently supported only on macOS".to_string())
    }

    #[cfg(target_os = "macos")]
    {
        let webkit_root = app_paths::home_dir()
            .join("Library")
            .join("WebKit")
            .join(&app.config().identifier)
            .join("WebsiteData")
            .join("Default");

        tauri::async_runtime::spawn_blocking(move || find_bundled_auth(&webkit_root))
            .await
            .map_err(|_| "bundled auth import task failed".to_string())?
    }
}

#[cfg(target_os = "macos")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredOrg2CloudAuth {
    kind: String,
    supabase_url: String,
    supabase_anon_key: String,
    user_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: f64,
}

#[cfg(target_os = "macos")]
struct AuthCandidate {
    raw: String,
    expires_at: f64,
    modified_at: SystemTime,
}

#[cfg(target_os = "macos")]
fn find_bundled_auth(webkit_root: &Path) -> Result<Option<String>, String> {
    let mut candidates = Vec::new();
    for origin_dir in bundled_origin_directories(webkit_root) {
        match read_candidate(&origin_dir) {
            Ok(Some(candidate)) => candidates.push(candidate),
            Ok(None) => {}
            Err(()) => {
                return Err("the bundled ORG2 Cloud auth record could not be read".to_string());
            }
        }
    }

    Ok(candidates
        .into_iter()
        .max_by(compare_candidates)
        .map(|candidate| candidate.raw))
}

#[cfg(target_os = "macos")]
fn bundled_origin_directories(webkit_root: &Path) -> Vec<PathBuf> {
    let mut origins = Vec::new();
    let Ok(partitions) = fs::read_dir(webkit_root) else {
        return origins;
    };

    for partition in partitions.flatten() {
        let Ok(origin_entries) = fs::read_dir(partition.path()) else {
            continue;
        };
        for origin_entry in origin_entries.flatten() {
            let origin_dir = origin_entry.path();
            if is_bundled_tauri_origin(&origin_dir.join("origin")) {
                origins.push(origin_dir);
            }
        }
    }

    origins
}

#[cfg(target_os = "macos")]
fn is_bundled_tauri_origin(origin_path: &Path) -> bool {
    let Ok(bytes) = fs::read(origin_path) else {
        return false;
    };
    let mut offset = 0;
    read_webkit_origin_component(&bytes, &mut offset) == Some(b"tauri".as_slice())
        && read_webkit_origin_component(&bytes, &mut offset) == Some(b"localhost".as_slice())
}

#[cfg(target_os = "macos")]
fn read_webkit_origin_component<'a>(bytes: &'a [u8], offset: &mut usize) -> Option<&'a [u8]> {
    let length_bytes: [u8; 4] = bytes.get(*offset..*offset + 4)?.try_into().ok()?;
    *offset += 4;
    let length = u32::from_le_bytes(length_bytes) as usize;

    // WebKit's serialized String starts with a non-null marker byte.
    if *bytes.get(*offset)? != 1 {
        return None;
    }
    *offset += 1;
    let value = bytes.get(*offset..*offset + length)?;
    *offset += length;
    Some(value)
}

#[cfg(target_os = "macos")]
fn read_candidate(origin_dir: &Path) -> Result<Option<AuthCandidate>, ()> {
    let database_path = origin_dir.join("LocalStorage/localstorage.sqlite3");
    if !database_path.is_file() {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ())?;

    let raw = connection
        .query_row(
            "SELECT value FROM ItemTable WHERE key = ?1 LIMIT 1",
            [ORG2_CLOUD_AUTH_STORAGE_KEY],
            |row| decode_webkit_string(row.get_ref(0)?).ok_or(rusqlite::Error::InvalidQuery),
        )
        .optional()
        .map_err(|_| ())?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let expires_at = validate_auth(&raw).ok_or(())?;
    let modified_at = newest_modification_time(&database_path);

    Ok(Some(AuthCandidate {
        raw,
        expires_at,
        modified_at,
    }))
}

#[cfg(target_os = "macos")]
fn decode_webkit_string(value: ValueRef<'_>) -> Option<String> {
    match value {
        ValueRef::Text(bytes) => std::str::from_utf8(bytes).ok().map(str::to_owned),
        ValueRef::Blob(bytes) if bytes.len() % 2 == 0 => {
            let units = bytes
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
            char::decode_utf16(units)
                .collect::<Result<String, _>>()
                .ok()
        }
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn validate_auth(raw: &str) -> Option<f64> {
    let auth: StoredOrg2CloudAuth = serde_json::from_str(raw).ok()?;
    let required_values = [
        auth.supabase_url.as_str(),
        auth.supabase_anon_key.as_str(),
        auth.user_id.as_str(),
        auth.access_token.as_str(),
        auth.refresh_token.as_str(),
    ];

    if auth.kind != "org2_cloud"
        || required_values.iter().any(|value| value.trim().is_empty())
        || !auth.expires_at.is_finite()
        || auth.expires_at <= 0.0
    {
        return None;
    }

    Some(auth.expires_at)
}

#[cfg(target_os = "macos")]
fn newest_modification_time(database_path: &Path) -> SystemTime {
    let wal_path = database_path.with_extension("sqlite3-wal");
    [database_path, wal_path.as_path()]
        .into_iter()
        .filter_map(|path| fs::metadata(path).ok()?.modified().ok())
        .max()
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

#[cfg(target_os = "macos")]
fn compare_candidates(left: &AuthCandidate, right: &AuthCandidate) -> Ordering {
    left.expires_at
        .total_cmp(&right.expires_at)
        .then_with(|| left.modified_at.cmp(&right.modified_at))
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const VALID_AUTH: &str = r#"{"kind":"org2_cloud","supabaseUrl":"https://example.supabase.co","supabaseAnonKey":"anon","userId":"user-1","accessToken":"access","refreshToken":"refresh","expiresAt":200}"#;

    fn seed_origin(root: &Path, name: &str, origin: &[u8], auth: Option<&str>) {
        let origin_dir = root.join(name).join(name);
        fs::create_dir_all(origin_dir.join("LocalStorage")).unwrap();
        fs::write(origin_dir.join("origin"), origin).unwrap();

        let connection =
            Connection::open(origin_dir.join("LocalStorage/localstorage.sqlite3")).unwrap();
        connection
            .execute(
                "CREATE TABLE ItemTable (key TEXT UNIQUE, value BLOB NOT NULL)",
                [],
            )
            .unwrap();
        if let Some(raw) = auth {
            let utf16 = raw
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            connection
                .execute(
                    "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
                    rusqlite::params![ORG2_CLOUD_AUTH_STORAGE_KEY, utf16],
                )
                .unwrap();
        }
    }

    fn serialized_origin(scheme: &str, host: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        for value in [scheme, host] {
            bytes.extend_from_slice(&(value.len() as u32).to_le_bytes());
            bytes.push(1);
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes
    }

    #[test]
    fn imports_the_allow_listed_key_from_the_bundled_origin() {
        let temp = TempDir::new().unwrap();
        seed_origin(
            temp.path(),
            "bundle",
            &serialized_origin("tauri", "localhost"),
            Some(VALID_AUTH),
        );

        assert_eq!(
            find_bundled_auth(temp.path()).unwrap().as_deref(),
            Some(VALID_AUTH)
        );
    }

    #[test]
    fn ignores_dev_origins_and_rejects_invalid_auth_payloads() {
        let temp = TempDir::new().unwrap();
        seed_origin(
            temp.path(),
            "dev",
            &serialized_origin("http", "localhost"),
            Some(VALID_AUTH),
        );
        seed_origin(
            temp.path(),
            "invalid",
            &serialized_origin("tauri", "localhost"),
            Some(r#"{"kind":"other"}"#),
        );

        assert!(find_bundled_auth(temp.path()).is_err());
    }

    #[test]
    fn reports_signed_out_when_the_bundled_key_is_missing() {
        let temp = TempDir::new().unwrap();
        seed_origin(
            temp.path(),
            "bundle",
            &serialized_origin("tauri", "localhost"),
            None,
        );

        assert_eq!(find_bundled_auth(temp.path()).unwrap(), None);
    }
}
