//! Channel-aware app update checks (stable / beta).
//!
//! The updater plugin's JS `check()` can only hit the endpoints baked into
//! `tauri.conf.json`, which serve the stable channel. This command rebuilds
//! the updater with the endpoint for the requested channel and registers the
//! resulting update in the webview resource table — the same table the
//! plugin's own `download`/`install`/`close` commands read from — so the
//! frontend wraps the returned metadata in the plugin's `Update` class and
//! the rest of the update flow works unchanged.
//!
//! The channel → URL map lives here on purpose: the webview picks a channel,
//! never a URL, preserving the plugin's rule that page code cannot point the
//! updater at arbitrary endpoints.

use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::Duration,
};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Manager, ResourceId, Webview};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;
use uuid::Uuid;

/// Stable channel: GitHub's `releases/latest` alias, which excludes
/// prereleases. Must stay in sync with `plugins.updater.endpoints` in
/// `tauri.conf.json`.
const STABLE_MANIFEST_URL: &str =
    "https://github.com/org2AI/ORG2/releases/latest/download/latest.json";

/// Beta channel: rolling `updater` release whose `beta.json` is overwritten
/// by every release (stable and beta) in `.github/workflows/release.yaml`,
/// so it always points at the newest build of either kind.
const BETA_MANIFEST_URL: &str =
    "https://github.com/org2AI/ORG2/releases/download/updater/beta.json";

const PRODUCTION_MACOS_APP_PATH: &str = "/Applications/ORG2.app";
const PRODUCTION_BUNDLE_IDENTIFIER: &str = "org2ai.org2";

static SEPARATE_INSTALL_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AppBuildKind {
    Local,
    Release,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppUpdateInstallStrategy {
    InPlace,
    SeparateMacosApplication,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppBuildProvenance {
    kind: AppBuildKind,
    git_ref: String,
    git_sha: String,
    install_strategy: AppUpdateInstallStrategy,
}

fn compiled_build_kind() -> AppBuildKind {
    match env!("ORGII_BUILD_KIND") {
        "release" => AppBuildKind::Release,
        "local" => AppBuildKind::Local,
        value => panic!("unsupported compiled ORGII_BUILD_KIND: {value}"),
    }
}

fn install_strategy(kind: AppBuildKind) -> AppUpdateInstallStrategy {
    match kind {
        AppBuildKind::Release => AppUpdateInstallStrategy::InPlace,
        AppBuildKind::Local if cfg!(target_os = "macos") => {
            AppUpdateInstallStrategy::SeparateMacosApplication
        }
        AppBuildKind::Local => AppUpdateInstallStrategy::Unavailable,
    }
}

fn build_provenance() -> AppBuildProvenance {
    let kind = compiled_build_kind();
    AppBuildProvenance {
        kind,
        git_ref: env!("ORGII_BUILD_REF").to_string(),
        git_sha: env!("ORGII_BUILD_SHA").to_string(),
        install_strategy: install_strategy(kind),
    }
}

#[tauri::command]
pub fn get_app_build_provenance() -> AppBuildProvenance {
    build_provenance()
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Beta,
}

impl UpdateChannel {
    fn manifest_url(self) -> &'static str {
        match self {
            UpdateChannel::Stable => STABLE_MANIFEST_URL,
            UpdateChannel::Beta => BETA_MANIFEST_URL,
        }
    }
}

/// Mirror of the updater plugin's check-command response so the frontend can
/// construct the plugin's `Update` class around it (`rid` is live in the
/// webview resource table).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum SeparateInstallDownloadEvent {
    Started {
        #[serde(rename = "contentLength")]
        content_length: Option<u64>,
    },
    Progress {
        #[serde(rename = "chunkLength")]
        chunk_length: usize,
    },
    Finished,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparateInstallResult {
    target_path: String,
    version: String,
}

#[tauri::command]
pub async fn check_app_update(
    webview: Webview,
    channel: UpdateChannel,
    timeout_ms: Option<u64>,
) -> Result<Option<UpdateMetadata>, String> {
    let endpoint = Url::parse(channel.manifest_url()).map_err(|err| err.to_string())?;

    let mut builder = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|err| err.to_string())?;
    if let Some(timeout_ms) = timeout_ms {
        builder = builder.timeout(Duration::from_millis(timeout_ms));
    }

    let updater = builder.build().map_err(|err| err.to_string())?;
    let update = updater.check().await.map_err(|err| err.to_string())?;

    Ok(update.map(|update| UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: update.date.and_then(|date| {
            date.format(&time::format_description::well_known::Rfc3339)
                .ok()
        }),
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    }))
}

/// Download a signature-verified release and install it beside a local build.
///
/// This command is deliberately unavailable to release builds: official
/// applications keep using the updater plugin's normal in-place path. The
/// local process is neither exited nor relaunched after installation.
#[tauri::command]
pub async fn install_app_update_separately(
    webview: Webview,
    update_rid: ResourceId,
    on_event: Channel<SeparateInstallDownloadEvent>,
) -> Result<SeparateInstallResult, String> {
    let provenance = build_provenance();
    if provenance.install_strategy != AppUpdateInstallStrategy::SeparateMacosApplication {
        return Err("This build does not support separate application installation".to_string());
    }

    let _install_guard = SEPARATE_INSTALL_LOCK
        .try_lock()
        .map_err(|_| "A separate application installation is already running".to_string())?;
    let update = webview
        .resources_table()
        .get::<Update>(update_rid)
        .map_err(|err| err.to_string())?;
    let update = (*update).clone();
    let version = update.version.clone();

    let progress_channel = on_event.clone();
    let finished_channel = on_event;
    let mut started = false;
    let bytes = update
        .download(
            move |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = progress_channel
                        .send(SeparateInstallDownloadEvent::Started { content_length });
                }
                let _ =
                    progress_channel.send(SeparateInstallDownloadEvent::Progress { chunk_length });
            },
            move || {
                let _ = finished_channel.send(SeparateInstallDownloadEvent::Finished);
            },
        )
        .await
        .map_err(|err| err.to_string())?;

    let expected_version = version.clone();
    let target = PathBuf::from(PRODUCTION_MACOS_APP_PATH);
    let install_target = target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        install_release_archive(&bytes, &install_target, &expected_version)
    })
    .await
    .map_err(|err| format!("Release installer task failed: {err}"))??;

    Ok(SeparateInstallResult {
        target_path: target.to_string_lossy().into_owned(),
        version,
    })
}

fn install_release_archive(
    archive_bytes: &[u8],
    target_path: &Path,
    expected_version: &str,
) -> Result<(), String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| format!("Invalid application target: {}", target_path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|err| format!("Cannot access {}: {err}", parent.display()))?;

    let staging_dir = tempfile::Builder::new()
        .prefix(".org2-release-staging-")
        .tempdir_in(parent)
        .map_err(|err| format!("Cannot stage the release in {}: {err}", parent.display()))?;
    let decoder = GzDecoder::new(Cursor::new(archive_bytes));
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(staging_dir.path())
        .map_err(|err| format!("Cannot unpack the signed release archive: {err}"))?;

    let staged_app = find_staged_application(staging_dir.path())?;
    validate_staged_application(&staged_app, expected_version)?;
    replace_application_bundle(&staged_app, target_path)
}

fn find_staged_application(staging_root: &Path) -> Result<PathBuf, String> {
    let mut applications = fs::read_dir(staging_root)
        .map_err(|err| format!("Cannot inspect the staged release: {err}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir() && path.extension().is_some_and(|ext| ext == "app"));
    let application = applications
        .next()
        .ok_or_else(|| "The signed release archive does not contain an application".to_string())?;
    if applications.next().is_some() {
        return Err("The signed release archive contains multiple applications".to_string());
    }
    Ok(application)
}

fn validate_staged_application(staged_app: &Path, expected_version: &str) -> Result<(), String> {
    let info_plist_path = staged_app.join("Contents/Info.plist");
    let info = plist::Value::from_file(&info_plist_path)
        .map_err(|err| format!("Cannot read {}: {err}", info_plist_path.display()))?;
    let info = info
        .as_dictionary()
        .ok_or_else(|| "The staged application Info.plist is not a dictionary".to_string())?;
    let bundle_identifier = info
        .get("CFBundleIdentifier")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "The staged application has no bundle identifier".to_string())?;
    if bundle_identifier != PRODUCTION_BUNDLE_IDENTIFIER {
        return Err(format!(
            "Unexpected staged bundle identifier: {bundle_identifier}"
        ));
    }
    let version = info
        .get("CFBundleShortVersionString")
        .and_then(plist::Value::as_string)
        .ok_or_else(|| "The staged application has no version".to_string())?;
    if version != expected_version {
        return Err(format!(
            "Staged application version {version} does not match update {expected_version}"
        ));
    }
    Ok(())
}

fn replace_application_bundle(staged_app: &Path, target_path: &Path) -> Result<(), String> {
    let parent = target_path
        .parent()
        .ok_or_else(|| format!("Invalid application target: {}", target_path.display()))?;
    let backup_path = parent.join(format!(".ORG2.app.backup-{}", Uuid::new_v4()));
    let had_existing_target = target_path.exists();

    if had_existing_target {
        fs::rename(target_path, &backup_path).map_err(|err| {
            format!(
                "Cannot stage the existing {} for replacement: {err}",
                target_path.display()
            )
        })?;
    }

    if let Err(install_error) = fs::rename(staged_app, target_path) {
        let restore_result = had_existing_target.then(|| fs::rename(&backup_path, target_path));
        return match restore_result {
            Some(Err(restore_error)) => Err(format!(
                "Cannot install {}: {install_error}; restoring the previous application also failed: {restore_error}",
                target_path.display()
            )),
            _ => Err(format!(
                "Cannot install {}: {install_error}",
                target_path.display()
            )),
        };
    }

    if had_existing_target {
        if let Err(err) = fs::remove_dir_all(&backup_path) {
            log::warn!(
                "Installed {} but could not remove backup {}: {err}",
                target_path.display(),
                backup_path.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};

    fn release_archive(bundle_identifier: &str, version: &str, marker: &[u8]) -> Vec<u8> {
        let source = tempfile::tempdir().expect("source tempdir");
        let app = source.path().join("ORG2.app");
        let contents = app.join("Contents");
        fs::create_dir_all(contents.join("Resources")).expect("app directories");

        let mut info = plist::Dictionary::new();
        info.insert(
            "CFBundleIdentifier".to_string(),
            plist::Value::String(bundle_identifier.to_string()),
        );
        info.insert(
            "CFBundleShortVersionString".to_string(),
            plist::Value::String(version.to_string()),
        );
        plist::Value::Dictionary(info)
            .to_file_xml(contents.join("Info.plist"))
            .expect("write plist");
        fs::write(contents.join("Resources/marker"), marker).expect("write marker");

        let encoder = GzEncoder::new(Vec::new(), Compression::default());
        let mut archive = tar::Builder::new(encoder);
        archive
            .append_dir_all("ORG2.app", &app)
            .expect("append app");
        archive
            .into_inner()
            .expect("finish tar")
            .finish()
            .expect("finish gzip")
    }

    #[test]
    fn release_builds_update_in_place_and_local_builds_never_guess() {
        assert_eq!(
            install_strategy(AppBuildKind::Release),
            AppUpdateInstallStrategy::InPlace
        );
        let expected_local = if cfg!(target_os = "macos") {
            AppUpdateInstallStrategy::SeparateMacosApplication
        } else {
            AppUpdateInstallStrategy::Unavailable
        };
        assert_eq!(install_strategy(AppBuildKind::Local), expected_local);
    }

    #[test]
    fn installs_a_valid_signed_release_payload_beside_the_local_build() {
        let root = tempfile::tempdir().expect("install root");
        let target = root.path().join("ORG2.app");
        fs::create_dir_all(target.join("Contents/Resources")).expect("old target");
        fs::write(target.join("Contents/Resources/marker"), b"old").expect("old marker");
        let archive = release_archive(PRODUCTION_BUNDLE_IDENTIFIER, "1.2.6", b"new");

        install_release_archive(&archive, &target, "1.2.6").expect("install release");

        assert_eq!(
            fs::read(target.join("Contents/Resources/marker")).expect("new marker"),
            b"new"
        );
        assert_eq!(
            fs::read_dir(root.path())
                .expect("root entries")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains("backup"))
                .count(),
            0
        );
    }

    #[test]
    fn rejects_a_release_with_the_wrong_bundle_identity_without_touching_target() {
        let root = tempfile::tempdir().expect("install root");
        let target = root.path().join("ORG2.app");
        fs::create_dir_all(target.join("Contents/Resources")).expect("old target");
        fs::write(target.join("Contents/Resources/marker"), b"old").expect("old marker");
        let archive = release_archive("example.invalid", "1.2.6", b"new");

        let error = install_release_archive(&archive, &target, "1.2.6")
            .expect_err("wrong identity must be rejected");

        assert!(error.contains("Unexpected staged bundle identifier"));
        assert_eq!(
            fs::read(target.join("Contents/Resources/marker")).expect("old marker"),
            b"old"
        );
    }

    #[test]
    fn rejects_a_release_whose_bundle_version_does_not_match_manifest() {
        let root = tempfile::tempdir().expect("install root");
        let target = root.path().join("ORG2.app");
        let archive = release_archive(PRODUCTION_BUNDLE_IDENTIFIER, "1.2.5", b"new");

        let error = install_release_archive(&archive, &target, "1.2.6")
            .expect_err("mismatched version must be rejected");

        assert!(error.contains("does not match update 1.2.6"));
        assert!(!target.exists());
    }
}
