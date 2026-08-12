//! Cloud device identity for member-runtime sharing.
//!
//! Serves the `cloud_device_identity` Tauri command: a stable per-install
//! UUIDv4 read-or-created at `~/.orgii/cloud_device_id` plus a human-readable
//! machine label. The id is what a member's runtime status rows key their
//! "machine" on in `org2_cloud`.
//!
//! Privacy invariant: this is a SEPARATE file and id from the anonymous
//! diagnostics `install_id` (`~/.orgii/diagnostics/install_id`). It is never
//! read from, derived from, or written to that file — device rows a user
//! knowingly shares with their org must stay unlinkable from usage
//! diagnostics. The persistence itself follows the same idiom
//! (`usage_diagnostics::queue::ensure_install_id`): reuse any non-empty
//! trimmed content, else write a fresh UUIDv4 atomically with owner-only
//! permissions.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use uuid::Uuid;

/// Device-id file name directly under the ORGII data root.
const CLOUD_DEVICE_ID_FILE: &str = "cloud_device_id";

/// Wire shape of `cloud_device_identity` (camelCase per the member-runtime
/// contract in `features/Org2Cloud/memberRuntime/types.ts`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDeviceIdentity {
    pub device_id: String,
    pub machine_label: String,
}

fn cloud_device_id_path() -> PathBuf {
    app_paths::orgii_root().join(CLOUD_DEVICE_ID_FILE)
}

/// Stable per-install device identity for member-runtime pushes.
#[tauri::command]
pub async fn cloud_device_identity() -> Result<CloudDeviceIdentity, String> {
    tokio::task::spawn_blocking(cloud_device_identity_blocking)
        .await
        .map_err(|err| format!("Cloud device identity task failed: {err}"))?
}

fn cloud_device_identity_blocking() -> Result<CloudDeviceIdentity, String> {
    let device_id = ensure_device_id(&cloud_device_id_path())?;
    Ok(CloudDeviceIdentity {
        device_id,
        machine_label: perf_utils::system_runtime::machine_label(),
    })
}

/// Read-or-create the persisted device id. A non-empty file only counts as
/// "existing" if its trimmed content parses as a UUID — a corrupted or
/// hand-edited value is treated the same as a blank file (regenerated and
/// rewritten) instead of being propagated verbatim into `org2_cloud` forever.
/// The parsed value's canonical `to_string()` form is reused (not the raw
/// trimmed text) so casing/formatting always normalizes to lowercase-hyphenated.
fn ensure_device_id(path: &Path) -> Result<String, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| {
            format!(
                "Failed to create data directory {}: {}",
                parent.display(),
                err
            )
        })?;
    }

    if path.exists() {
        let existing = fs::read_to_string(path)
            .map_err(|err| format!("Failed to read cloud device id {}: {}", path.display(), err))?;
        let trimmed = existing.trim();
        if let Ok(parsed) = Uuid::parse_str(trimmed) {
            return Ok(parsed.to_string());
        }
    }

    let device_id = Uuid::new_v4().to_string();
    write_atomic(path, device_id.as_bytes())?;
    if let Err(err) = app_paths::set_sensitive_file_permissions(path) {
        tracing::warn!(
            error = %err,
            path = %path.display(),
            "[CloudIdentity] Failed to restrict cloud device id file permissions"
        );
    }
    Ok(device_id)
}

/// Atomic replace (unique temp file + fsync + rename), mirroring the
/// diagnostics queue's `write_atomic` so a crash mid-write can never leave a
/// truncated id behind.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error while writing cloud device id: {}", err))?
        .as_nanos();
    let tmp_path = path.with_extension(format!("tmp-{}", nanos));
    {
        let mut file = File::create(&tmp_path).map_err(|err| {
            format!(
                "Failed to create cloud device id temp file {}: {}",
                tmp_path.display(),
                err
            )
        })?;
        file.write_all(bytes).map_err(|err| {
            format!(
                "Failed to write cloud device id temp file {}: {}",
                tmp_path.display(),
                err
            )
        })?;
        file.sync_all().map_err(|err| {
            format!(
                "Failed to sync cloud device id temp file {}: {}",
                tmp_path.display(),
                err
            )
        })?;
    }
    fs::rename(&tmp_path, path).map_err(|err| {
        format!(
            "Failed to replace cloud device id {} with {}: {}",
            path.display(),
            tmp_path.display(),
            err
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::test_env;

    #[test]
    fn device_identity_round_trip_is_stable() {
        let _sandbox = test_env::sandbox();

        let first = cloud_device_identity_blocking().expect("create identity");
        assert!(
            Uuid::parse_str(&first.device_id).is_ok(),
            "device id must be a UUIDv4: {}",
            first.device_id
        );
        assert!(!first.machine_label.trim().is_empty());
        assert!(first.machine_label.chars().count() <= 64);

        let second = cloud_device_identity_blocking().expect("reread identity");
        assert_eq!(first.device_id, second.device_id);

        let path = cloud_device_id_path();
        assert!(path.starts_with(app_paths::orgii_root()));
        assert!(path.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path)
                .expect("stat cloud device id")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "device id must be owner-only");
        }
    }

    #[test]
    fn device_id_reuses_existing_trimmed_content() {
        let _sandbox = test_env::sandbox();

        let path = cloud_device_id_path();
        fs::create_dir_all(path.parent().expect("root parent")).expect("create root");
        let seeded = Uuid::new_v4().to_string();
        fs::write(&path, format!("  {seeded}\n")).expect("seed id file");

        let id = ensure_device_id(&path).expect("reuse existing id");
        assert_eq!(id, seeded);
    }

    #[test]
    fn device_id_regenerates_on_invalid_content() {
        let _sandbox = test_env::sandbox();

        let path = cloud_device_id_path();
        fs::create_dir_all(path.parent().expect("root parent")).expect("create root");
        fs::write(&path, "  existing-device-id\n").expect("seed garbage id file");

        let id = ensure_device_id(&path).expect("regenerate id");
        assert_ne!(id, "existing-device-id");
        assert!(
            Uuid::parse_str(&id).is_ok(),
            "regenerated id must be a UUID: {id}"
        );

        // The garbage content must actually have been rewritten on disk, not
        // just papered over in the returned value.
        let on_disk = fs::read_to_string(&path).expect("reread id file");
        assert_eq!(on_disk.trim(), id);

        // And it sticks on the next read.
        assert_eq!(ensure_device_id(&path).expect("reread"), id);
    }

    #[test]
    fn device_id_replaces_blank_file() {
        let _sandbox = test_env::sandbox();

        let path = cloud_device_id_path();
        fs::create_dir_all(path.parent().expect("root parent")).expect("create root");
        fs::write(&path, "   \n").expect("seed blank file");

        let id = ensure_device_id(&path).expect("regenerate id");
        assert!(Uuid::parse_str(&id).is_ok());
        // And it sticks on the next read.
        assert_eq!(ensure_device_id(&path).expect("reread"), id);
    }
}
