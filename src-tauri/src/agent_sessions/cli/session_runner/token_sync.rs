//! Post-run token sync from CLI auth files back to the key vault.

use core_types::providers::CodexCliAuthConfig;
use key_vault::key_store::{CliOAuthTokenSync, CliOAuthTokenSyncOutcome, ModelType, KEY_SERVICE};

pub(super) fn sync_codex_cli_auth_to_key_vault(
    account_id: Option<&str>,
    launched_access_token: Option<&str>,
) -> Result<(), String> {
    let Some(account_id) = account_id else {
        return Ok(());
    };
    let auth_path = app_paths::codex_cli_profile_dir(account_id).join("auth.json");
    if !auth_path.exists() {
        return Ok(());
    }

    let content = std::fs::read_to_string(&auth_path).map_err(|err| {
        format!(
            "Failed to read Codex auth file {}: {err}",
            auth_path.display()
        )
    })?;
    let auth: CodexCliAuthConfig = serde_json::from_str(&content).map_err(|err| {
        format!(
            "Failed to parse Codex auth file {}: {err}",
            auth_path.display()
        )
    })?;
    let Some(tokens) = auth.tokens else {
        return Ok(());
    };

    let access_token = tokens.access_token.filter(|token| !token.trim().is_empty());
    let refresh_token = tokens
        .refresh_token
        .filter(|token| !token.trim().is_empty());
    let id_token = tokens.id_token.filter(|token| !token.trim().is_empty());

    if access_token.is_none() && refresh_token.is_none() && id_token.is_none() {
        return Ok(());
    }

    let outcome = KEY_SERVICE
        .sync_cli_oauth_tokens_if_current(
            account_id,
            ModelType::Codex,
            launched_access_token,
            CliOAuthTokenSync {
                access_token,
                refresh_token,
                id_token,
            },
        )
        .map_err(|err| format!("Failed to save refreshed Codex CLI tokens: {err}"))?;
    if matches!(outcome, CliOAuthTokenSyncOutcome::SkippedNewerKeyVaultToken) {
        tracing::warn!(
            "[CodeSession] Skipped Codex CLI auth sync because Key Vault has a newer access token"
        );
    }
    Ok(())
}
