//! Write-back of OAuth tokens rotated by an external CLI process, guarded so a
//! stale launch never clobbers a newer Key Vault token.

use chrono::Utc;

use core_types::providers::{CODEX_ID_TOKEN_ENV_KEY, CODEX_REFRESH_TOKEN_ENV_KEY};

use super::super::types::{AuthMethod, ModelKey, ModelType};
use super::KeyService;

#[derive(Debug, Clone, Default)]
pub struct CliOAuthTokenSync {
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

#[derive(Debug, Clone)]
pub enum CliOAuthTokenSyncOutcome {
    Updated(Box<ModelKey>),
    SkippedNewerKeyVaultToken,
    NotApplicable,
}

impl KeyService {
    pub fn sync_cli_oauth_tokens_if_current(
        &self,
        key_id: &str,
        model_type: ModelType,
        launched_access_token: Option<&str>,
        tokens: CliOAuthTokenSync,
    ) -> Result<CliOAuthTokenSyncOutcome, String> {
        self.update_store(|store| {
            let Some(entry) = store.keys.get_mut(key_id) else {
                return Ok(CliOAuthTokenSyncOutcome::NotApplicable);
            };
            if entry.model_type != model_type || entry.auth_method != AuthMethod::Oauth {
                return Ok(CliOAuthTokenSyncOutcome::NotApplicable);
            }

            let current_access_token = entry
                .session_token
                .as_deref()
                .filter(|token| !token.trim().is_empty());
            let launched_access_token =
                launched_access_token.filter(|token| !token.trim().is_empty());
            if let (Some(current), Some(launched)) = (current_access_token, launched_access_token) {
                if current != launched {
                    return Ok(CliOAuthTokenSyncOutcome::SkippedNewerKeyVaultToken);
                }
            }

            let mut changed = false;
            if let Some(token) = tokens.access_token.filter(|token| !token.trim().is_empty()) {
                if entry.session_token.as_deref() != Some(token.as_str()) {
                    entry.session_token = Some(token);
                    changed = true;
                }
            }
            if let Some(token) = tokens
                .refresh_token
                .filter(|token| !token.trim().is_empty())
            {
                let refresh_key = match model_type {
                    ModelType::Codex => CODEX_REFRESH_TOKEN_ENV_KEY,
                    _ => return Ok(CliOAuthTokenSyncOutcome::NotApplicable),
                };
                if entry.env_vars.get(refresh_key) != Some(&token) {
                    entry.env_vars.insert(refresh_key.to_string(), token);
                    changed = true;
                }
            }
            if let Some(token) = tokens.id_token.filter(|token| !token.trim().is_empty()) {
                if model_type == ModelType::Codex
                    && entry.env_vars.get(CODEX_ID_TOKEN_ENV_KEY) != Some(&token)
                {
                    entry
                        .env_vars
                        .insert(CODEX_ID_TOKEN_ENV_KEY.to_string(), token);
                    changed = true;
                }
            }
            if changed {
                Self::reset_oauth_refresh_failure_state(entry);
                entry.enabled = true;
                entry.updated_at = Utc::now();
                store.updated_at = Utc::now();
            }
            Ok(CliOAuthTokenSyncOutcome::Updated(Box::new(entry.clone())))
        })?
    }
}
