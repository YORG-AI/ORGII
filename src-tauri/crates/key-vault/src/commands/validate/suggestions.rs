//! Credential suggestions: the offline probe command plus the import
//! pipeline that turns a selected suggestion into a vault entry.
//!
//! Import never trusts anything the frontend sends beyond the suggestion's
//! coordinates. Every secret is re-read on this side — through the agent's
//! full detector for OAuth/state stores (refresh tokens, account metadata
//! and validation come along), or straight from the env var / shell
//! profile / config file for plain API keys, which are then validated with
//! the same validators the manual wizard uses.

use serde::{Deserialize, Serialize};

use crate::auto_detect::{
    auto_detect_key, probe_credential_suggestions, resolve_generic_secret, resolves_via_detector,
    secret_fingerprint, CredentialSuggestion, DetectedKey, SuggestionSourceKind,
};
use crate::commands::validate::run_validate_key;
use crate::commands::{save_key, KeyInfo, SaveKeyRequest};
use crate::key_store::{ModelType, KEY_SERVICE};

/// Scan the machine for credentials other coding tools have left behind.
/// Offline and cheap; safe to call on every Key Vault visit.
#[tauri::command]
pub async fn list_credential_suggestions() -> Result<Vec<CredentialSuggestion>, String> {
    tokio::task::spawn_blocking(|| {
        let stored = KEY_SERVICE.list_keys();
        probe_credential_suggestions(&stored)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialImportStatus {
    Imported,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialImportItemReport {
    pub id: String,
    pub agent_type: String,
    pub source_label: String,
    pub status: CredentialImportStatus,
    /// Vault entry id when `status == Imported`.
    #[serde(default)]
    pub key_id: Option<String>,
    /// Filled when `status == Failed`.
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialImportReport {
    pub items: Vec<CredentialImportItemReport>,
}

/// Import a batch of suggestions. Per-item report so partial failures stay
/// visible; one bad row never aborts the batch.
#[tauri::command]
pub async fn import_credential_suggestions(
    selections: Vec<CredentialSuggestion>,
) -> Result<CredentialImportReport, String> {
    let mut items = Vec::with_capacity(selections.len());
    for selection in selections {
        let report = match import_one(&selection).await {
            Ok(saved) => CredentialImportItemReport {
                id: selection.id.clone(),
                agent_type: selection.agent_type.clone(),
                source_label: selection.source_label.clone(),
                status: CredentialImportStatus::Imported,
                key_id: Some(saved.id),
                error: None,
            },
            Err(error) => CredentialImportItemReport {
                id: selection.id.clone(),
                agent_type: selection.agent_type.clone(),
                source_label: selection.source_label.clone(),
                status: CredentialImportStatus::Failed,
                key_id: None,
                error: Some(error),
            },
        };
        items.push(report);
    }
    Ok(CredentialImportReport { items })
}

async fn import_one(selection: &CredentialSuggestion) -> Result<KeyInfo, String> {
    let model_type = ModelType::from_str(&selection.agent_type)
        .ok_or_else(|| format!("Unknown agent type: {}", selection.agent_type))?;

    if resolves_via_detector(selection) {
        import_via_detector(selection).await
    } else {
        import_generic(selection, &model_type).await
    }
}

/// Does a detector result carry the secret the suggestion was built from?
/// Fingerprint-less suggestions (keychain / opaque state DB) match on auth
/// method instead — the detector is the only reader for those.
fn detected_key_matches(key: &DetectedKey, selection: &CredentialSuggestion) -> bool {
    match selection.fingerprint.as_deref() {
        Some(expected) => {
            let mut candidates: Vec<String> = Vec::new();
            if let Some(api_key) = key.api_key.as_deref() {
                candidates.push(secret_fingerprint(api_key));
            }
            if let Some(token) = key.session_token.as_deref() {
                candidates.push(secret_fingerprint(token));
                if let Some(bare) = token.split("%3A%3A").nth(1) {
                    candidates.push(secret_fingerprint(bare));
                }
            }
            candidates.iter().any(|candidate| candidate == expected)
        }
        None => key.auth_method == selection.auth_method,
    }
}

async fn import_via_detector(selection: &CredentialSuggestion) -> Result<KeyInfo, String> {
    let result = auto_detect_key(&selection.agent_type).await;
    let key = result
        .keys
        .into_iter()
        .find(|key| detected_key_matches(key, selection))
        .ok_or_else(|| {
            format!(
                "Credential at {} is no longer available",
                selection.source_label
            )
        })?;

    if key.validated == Some(false) {
        return Err(key
            .validation_message
            .unwrap_or_else(|| "Credential failed validation".to_string()));
    }

    let models = key.available_models.clone().unwrap_or_default();
    let request = SaveKeyRequest {
        id: None,
        name: Some(key.name.clone()),
        description: None,
        agent_type: selection.agent_type.clone(),
        api_key: key.api_key.clone(),
        session_token: key.session_token.clone(),
        base_url: key.base_url.clone(),
        protocol: None,
        env_vars: key.env_vars.clone(),
        account_metadata: key.account_metadata.clone(),
        available_models: Some(models.clone()),
        enabled_models: Some(models),
        model_aliases: None,
        model_variants: None,
        default_variants: None,
        quota_info: key
            .quota_info
            .as_ref()
            .and_then(|quota| serde_json::to_value(quota).ok()),
        has_local_key: Some(true),
        is_listed: None,
        auth_method: Some(key.auth_method.clone()),
        listing_id: None,
        enabled: Some(true),
    };
    save_key(request).await
}

async fn import_generic(
    selection: &CredentialSuggestion,
    model_type: &ModelType,
) -> Result<KeyInfo, String> {
    let (secret, base_url) = resolve_generic_secret(selection).ok_or_else(|| {
        format!(
            "Credential at {} is no longer available",
            selection.source_label
        )
    })?;

    let imported = crate::auto_detect::suggestions::cc_switch_connection_metadata(selection)?;
    if selection.source_kind == SuggestionSourceKind::CcSwitch {
        if selection.fingerprint.as_deref() != Some(secret_fingerprint(&secret).as_str()) {
            return Err("cc-switch credential changed; refresh the import list".into());
        }
        if let Some(existing) = KEY_SERVICE.list_keys().iter().find(|key| {
            key.api_key.as_deref() == Some(secret.as_str())
                && key.base_url == base_url
                && key.model_type == *model_type
        }) {
            return crate::commands::get_key_by_id(existing.id.clone())
                .await?
                .ok_or("Imported connection disappeared".into());
        }
    }
    // A configured cc-switch model can be imported offline. Actual endpoint
    // compatibility is tested explicitly before this connection can be applied.
    // Same validators the manual wizard runs. CLI agents without a
    // validator (Amp, Devin, ...) are saved unvalidated: their vault entry
    // only feeds env injection at launch and needs no model list.
    let models = if let Some((model, _)) = &imported {
        vec![model.clone()]
    } else {
        match run_validate_key(
            selection.agent_type.clone(),
            secret.clone(),
            base_url.clone(),
            None,
            None,
            None,
        )
        .await
        {
            Ok(result) if result.valid => result.models_available,
            Ok(result) => return Err(result.message),
            Err(_) if model_type.is_cli_agent() => Vec::new(),
            Err(err) => return Err(err),
        }
    };

    if imported.is_some() {
        let mut candidate = crate::key_store::ModelKey::new(model_type.clone());
        candidate.api_key = Some(secret.clone());
        candidate.base_url = base_url.clone();
        candidate.available_models = models.clone();
        crate::harness_connections::resolve(&selection.agent_type, &candidate, None)?;
    }

    // cc-switch rows are labelled by profile name; everything else is best
    // identified by the variable / provider it came from, then the file.
    let name = match (selection.source_kind, selection.source_ref.as_deref()) {
        (SuggestionSourceKind::CcSwitch, _) | (_, None) => selection.source_label.clone(),
        (_, Some(reference)) => reference.to_string(),
    };
    let request = SaveKeyRequest {
        id: None,
        name: Some(name),
        description: None,
        agent_type: selection.agent_type.clone(),
        api_key: Some(secret),
        session_token: None,
        base_url,
        protocol: imported.map(|(_, protocol)| protocol),
        env_vars: None,
        account_metadata: None,
        available_models: Some(models.clone()),
        enabled_models: Some(models),
        model_aliases: None,
        model_variants: None,
        default_variants: None,
        quota_info: None,
        has_local_key: Some(true),
        is_listed: None,
        auth_method: Some("api_key".to_string()),
        listing_id: None,
        enabled: Some(true),
    };
    save_key(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggestion(fingerprint: Option<&str>, auth_method: &str) -> CredentialSuggestion {
        CredentialSuggestion {
            id: "codex:oauth_store:~/.codex/auth.json".into(),
            agent_type: "codex".into(),
            auth_method: auth_method.into(),
            source_kind: SuggestionSourceKind::OauthStore,
            source_label: "~/.codex/auth.json".into(),
            source_path: None,
            source_ref: None,
            fingerprint: fingerprint.map(str::to_string),
            already_imported: false,
        }
    }

    fn detected(api_key: Option<&str>, session_token: Option<&str>, auth: &str) -> DetectedKey {
        DetectedKey {
            id: "x".into(),
            name: "x".into(),
            auth_method: auth.into(),
            api_key: api_key.map(str::to_string),
            session_token: session_token.map(str::to_string),
            base_url: None,
            env_vars: None,
            account_metadata: None,
            available_models: None,
            quota_info: None,
            validated: None,
            validation_message: None,
        }
    }

    #[test]
    fn matches_detector_output_by_secret_fingerprint() {
        let fp = secret_fingerprint("eyJ.access");
        let sel = suggestion(Some(&fp), "oauth");
        assert!(detected_key_matches(
            &detected(None, Some("eyJ.access"), "oauth"),
            &sel
        ));
        assert!(!detected_key_matches(
            &detected(None, Some("eyJ.other"), "oauth"),
            &sel
        ));
        assert!(detected_key_matches(
            &detected(Some("eyJ.access"), None, "api_key"),
            &sel
        ));
    }

    #[test]
    fn cursor_session_token_matches_on_the_bare_jwt() {
        let fp = secret_fingerprint("header.payload.sig");
        let sel = suggestion(Some(&fp), "oauth");
        assert!(detected_key_matches(
            &detected(None, Some("user_1%3A%3Aheader.payload.sig"), "oauth"),
            &sel
        ));
    }

    #[test]
    fn fingerprint_less_suggestions_match_on_auth_method() {
        let sel = suggestion(None, "oauth");
        assert!(detected_key_matches(
            &detected(None, Some("anything"), "oauth"),
            &sel
        ));
        assert!(!detected_key_matches(
            &detected(Some("anything"), None, "api_key"),
            &sel
        ));
    }
}
