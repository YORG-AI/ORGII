use identity_broker::{
    IdentityBroker, IdentityRealm, ImportLegacyIdentityOutcome, LegacySupabaseSession, SecretBytes,
};
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::commands::IdentityCommandError;

const SHARED_AUTH_STORE_PATH: &str = "shared-service-auth.json";
const LEGACY_CLOUD_AUTH_KEY: &str = "orgii:org2-cloud-v1:auth";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCloudProfile {
    display_name: Option<String>,
    primary_email: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCloudAuth {
    kind: String,
    supabase_url: String,
    supabase_anon_key: String,
    user_id: String,
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    profile: Option<LegacyCloudProfile>,
}

pub fn import_legacy_cloud_session(
    app: &AppHandle,
    broker: &IdentityBroker,
) -> Result<Option<ImportLegacyIdentityOutcome>, IdentityCommandError> {
    let store = match app.get_store(SHARED_AUTH_STORE_PATH) {
        Some(store) => store,
        None => app
            .store(SHARED_AUTH_STORE_PATH)
            .map_err(|_| IdentityCommandError::safe("legacy_store_unavailable"))?,
    };
    if store.reload_ignore_defaults().is_err() {
        // A brand-new profile legitimately has no store file yet. The
        // in-memory cache is still authoritative for this process.
        tracing::debug!("shared auth store has no persisted legacy snapshot");
    }
    let Some(serialized) = store
        .get(LEGACY_CLOUD_AUTH_KEY)
        .and_then(|value| value.as_str().map(str::to_owned))
    else {
        return Ok(None);
    };

    let serialized = SecretBytes::new(serialized.into_bytes());
    let mut legacy: LegacyCloudAuth = serde_json::from_slice(serialized.expose())
        .map_err(|_| IdentityCommandError::safe("legacy_identity_invalid"))?;
    drop(serialized);
    if legacy.kind != "org2_cloud" {
        return Err(IdentityCommandError::safe("legacy_identity_invalid"));
    }

    let access_credential = SecretBytes::new(std::mem::take(&mut legacy.access_token));
    if access_credential.is_empty() {
        return Err(IdentityCommandError::safe("legacy_identity_invalid"));
    }
    drop(access_credential);
    let profile = legacy.profile.take();
    let input = LegacySupabaseSession {
        realm: IdentityRealm::Org2Cloud,
        issuer: legacy.supabase_url,
        public_client_key: legacy.supabase_anon_key,
        subject: legacy.user_id,
        display_name: profile
            .as_ref()
            .and_then(|value| value.display_name.clone()),
        primary_email: profile
            .as_ref()
            .and_then(|value| value.primary_email.clone()),
        avatar_url: profile.and_then(|value| value.avatar_url),
        scopes: Vec::new(),
        expires_at_unix: Some(legacy.expires_at),
        refresh_credential: SecretBytes::new(std::mem::take(&mut legacy.refresh_token)),
    };

    // This is the internal shadow rollout. The Broker has not performed a
    // trusted endpoint verification yet, so the plan's migration FSM forbids
    // deleting the legacy owner at this stage. The returned outcome makes
    // that decision explicit instead of treating Keychain read-back as proof.
    broker
        .import_legacy_supabase_session(input)
        .map(Some)
        .map_err(IdentityCommandError::from)
}
