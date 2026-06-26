use super::tmp_workspace_path;
use crate::config::Config;
use crate::harness;

const GEMINI_ACCOUNT_ENV: &str = "SOYD_E2E_GEMINI_ACCOUNT_ID";
const GEMINI_MODEL_ENV: &str = "SOYD_E2E_GEMINI_MODEL";
const DEFAULT_GEMINI_CLI_MODEL: &str = "gemini-2.5-flash";

fn gemini_e2e_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|err| format!("Client build error: {err}"))
}

async fn post_gemini_cli_runtime(
    cfg: &Config,
    account_id: &str,
    model: &str,
    workspace: &str,
    marker: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/agent/test/cli/gemini-runtime", cfg.base_url);
    let client = gemini_e2e_client()?;
    let body = serde_json::json!({
        "content": format!("Reply with exactly {marker} and no other words."),
        "expected_text": marker,
        "account_id": account_id,
        "model": model,
        "workspace_path": workspace,
        "timeout_secs": 180,
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("HTTP error: {err}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|err| format!("HTTP response read error: {err}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {text}"));
    }
    let json: serde_json::Value = serde_json::from_str(&text)
        .map_err(|err| format!("JSON parse error: {err}; body={text}"))?;
    if let Some(err) = json.get("error").and_then(|value| value.as_str()) {
        return Err(err.to_string());
    }
    Ok(json)
}

fn require_bool(json: &serde_json::Value, key: &str) -> bool {
    json.get(key)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub async fn gemini_cli_account_scope(cfg: &Config) -> bool {
    let Ok(account_id) = std::env::var(GEMINI_ACCOUNT_ENV) else {
        println!("  [skip] Set {GEMINI_ACCOUNT_ENV} to run Gemini CLI account-scope E2E.");
        return true;
    };
    let model =
        std::env::var(GEMINI_MODEL_ENV).unwrap_or_else(|_| DEFAULT_GEMINI_CLI_MODEL.to_string());
    let workspace = tmp_workspace_path("gemini-cli-account-scope");
    let marker = format!("GEMINI_CLI_SCOPE_{}", cfg.session_prefix.replace(':', "_"));

    let result = async {
        eprintln!("[gemini-cli-account-scope-e2e] model={model} account_id={account_id}");
        let json = post_gemini_cli_runtime(cfg, &account_id, &model, &workspace, &marker).await?;
        let status = json
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let error_message = json
            .get("error_message")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let gemini_home = json
            .get("gemini_home")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        let expected_seen = json
            .get("expected_seen")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        if !gemini_home.contains(&account_id) {
            return Err(format!(
                "Gemini CLI profile is not account-scoped. account_id={account_id:?} gemini_home={gemini_home:?}"
            ));
        }
        if !require_bool(&json, "gemini_home_exists")
            || !require_bool(&json, "oauth_file_exists")
            || !require_bool(&json, "settings_file_exists")
        {
            return Err(format!(
                "Gemini CLI did not create the expected account profile files. gemini_home={gemini_home:?} home_exists={} oauth_exists={} settings_exists={}",
                require_bool(&json, "gemini_home_exists"),
                require_bool(&json, "oauth_file_exists"),
                require_bool(&json, "settings_file_exists"),
            ));
        }
        if !require_bool(&json, "oauth_has_access_token")
            || !require_bool(&json, "oauth_has_refresh_token")
            || !require_bool(&json, "oauth_has_expiry")
        {
            return Err(format!(
                "Gemini CLI OAuth profile is incomplete. access={} refresh={} expiry={} gemini_home={gemini_home:?}",
                require_bool(&json, "oauth_has_access_token"),
                require_bool(&json, "oauth_has_refresh_token"),
                require_bool(&json, "oauth_has_expiry"),
            ));
        }
        if json
            .get("settings_ide_enabled")
            .and_then(|value| value.as_bool())
            .unwrap_or(true)
        {
            return Err(format!(
                "Gemini CLI settings did not disable IDE companion. gemini_home={gemini_home:?}"
            ));
        }
        if status != "completed" {
            return Err(format!(
                "Gemini CLI account-scope run did not complete. status={status:?} error_message={error_message:?} gemini_home={gemini_home:?}"
            ));
        }
        if !expected_seen {
            return Err(format!(
                "Gemini CLI output was not persisted by parser. marker={marker:?} gemini_home={gemini_home:?}"
            ));
        }
        Ok(format!(
            "status={status} account_profile_verified=true expected_seen={expected_seen} account_id={account_id} gemini_home={gemini_home}"
        ))
    }
    .await;

    match result {
        Ok(summary) => harness::print_result(
            "gemini-cli-account-scope",
            &summary,
            &[(
                "Gemini CLI uses selected account profile and persists output",
                true,
            )],
        ),
        Err(err) => harness::print_error("gemini-cli-account-scope", &err),
    }
}
