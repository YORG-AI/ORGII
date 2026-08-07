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

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

/// Stable channel: GitHub's `releases/latest` alias, which excludes
/// prereleases. Must stay in sync with `plugins.updater.endpoints` in
/// `tauri.conf.json`.
const STABLE_MANIFEST_URL: &str =
    "https://github.com/yorgai/ORG2/releases/latest/download/latest.json";

/// Beta channel: rolling `updater` release whose `beta.json` is overwritten
/// by every release (stable and beta) in `.github/workflows/release.yaml`,
/// so it always points at the newest build of either kind.
const BETA_MANIFEST_URL: &str =
    "https://github.com/yorgai/ORG2/releases/download/updater/beta.json";

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
