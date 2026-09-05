//! Shared Settings/CLI-detail connection commands. No work starts on an idle timer.
mod probe;

use agent_cli::managed_config::{CliConfigManagedStatus, DirectConnection};
use key_vault::{
    harness_connections::{resolve, ResolvedHarnessConnection},
    key_store::KEY_SERVICE,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const RECEIPT_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_RECEIPTS: usize = 64;
type ReceiptMap = HashMap<String, (String, Instant)>;
static RECEIPTS: OnceLock<Mutex<ReceiptMap>> = OnceLock::new();
static TESTS: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionChoice {
    key_id: String,
    name: String,
    models: Vec<String>,
    endpoint: Option<String>,
    requires_test: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessConnectionView {
    pub config: CliConfigManagedStatus,
    installed: bool,
    choices: Vec<ConnectionChoice>,
}

fn selected(
    agent: &str,
    key_id: &str,
    model: Option<&str>,
) -> Result<ResolvedHarnessConnection, String> {
    let key = KEY_SERVICE
        .get_key_by_id(key_id)
        .ok_or("Selected connection no longer exists")?;
    resolve(agent, &key, model)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn harness_connection_status(
    agent_name: String,
) -> Result<HarnessConnectionView, String> {
    if !matches!(agent_name.as_str(), "claude_code" | "codex") {
        return Err("Unsupported harness".into());
    }
    let config = agent_cli::managed_config::cli_config_get_status(agent_name.clone()).await?;
    let (installed, choices) = tokio::task::spawn_blocking(move || {
        let installed =
            integrations::cli_binary_resolver::resolve_cli_binary_for_registry_name(&agent_name)
                .is_some_and(|binary| binary.installed());
        let choices = KEY_SERVICE
            .list_keys()
            .iter()
            .map(|key| {
                let result = resolve(&agent_name, key, None);
                ConnectionChoice {
                    key_id: key.id.clone(),
                    name: key
                        .name
                        .clone()
                        .unwrap_or_else(|| key.model_type.as_str().into()),
                    models: if key.enabled_models.is_empty() {
                        key.available_models.clone()
                    } else {
                        key.enabled_models.clone()
                    },
                    endpoint: result.as_ref().ok().map(|value| value.base_url.clone()),
                    requires_test: result.as_ref().is_ok_and(|value| value.requires_test),
                    reason: result.err(),
                }
            })
            .collect();
        (installed, choices)
    })
    .await
    .map_err(|_| "Connection lookup failed")?;
    Ok(HarnessConnectionView {
        config,
        choices,
        installed,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn harness_connection_test(
    agent_name: String,
    key_id: String,
    model: String,
    request_id: String,
) -> Result<String, String> {
    let (cancel, cancelled) = tokio::sync::oneshot::channel();
    {
        let mut tests = TESTS
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Connection tests unavailable")?;
        if tests.len() >= 4 || tests.contains_key(&request_id) {
            return Err("A connection test is already running; cancel or wait for it".into());
        }
        tests.insert(request_id.clone(), cancel);
    }
    let result = tokio::select! {
        _ = cancelled => Err("Connection test cancelled".to_string()),
        result = tokio::time::timeout(Duration::from_secs(45), async {
            verify_installed_version(&agent_name).await?;
            let connection = selected(&agent_name, &key_id, Some(&model))?;
            probe::test(&connection).await?;
            Ok::<_, String>(connection)
        }) => result.unwrap_or_else(|_| Err("Connection test timed out".into())),
    };
    if let Ok(mut tests) = TESTS.get_or_init(Default::default).lock() {
        tests.remove(&request_id);
    }
    let connection = result?;
    let token = uuid::Uuid::new_v4().to_string();
    let mut receipts = RECEIPTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Connection test receipts unavailable")?;
    receipts.retain(|_, (_, time)| time.elapsed() < RECEIPT_TTL);
    if receipts.len() >= MAX_RECEIPTS {
        if let Some(oldest) = receipts
            .iter()
            .min_by_key(|(_, (_, time))| *time)
            .map(|(token, _)| token.clone())
        {
            receipts.remove(&oldest);
        }
    }
    receipts.insert(token.clone(), (connection.revision, Instant::now()));
    Ok(token)
}

#[tauri::command(rename_all = "camelCase")]
pub fn harness_connection_cancel_test(request_id: String) {
    if let Ok(mut tests) = TESTS.get_or_init(Default::default).lock() {
        if let Some(cancel) = tests.remove(&request_id) {
            let _ = cancel.send(());
        }
    }
}

fn require_receipt(
    connection: &ResolvedHarnessConnection,
    receipt: Option<&str>,
) -> Result<(), String> {
    if !connection.requires_test {
        return Ok(());
    }
    let receipts = RECEIPTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Connection test receipts unavailable")?;
    if receipt
        .and_then(|token| receipts.get(token))
        .is_some_and(|(revision, time)| {
            revision == &connection.revision && time.elapsed() < RECEIPT_TTL
        })
    {
        return Ok(());
    }
    Err("Test this third-party endpoint and model before applying; previous evidence is missing, expired, or belongs to a different connection".into())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn harness_connection_apply(
    agent_name: String,
    key_id: String,
    model: String,
    routing: String,
    receipt: Option<String>,
    expected_hashes: std::collections::BTreeMap<String, Option<String>>,
) -> Result<CliConfigManagedStatus, String> {
    if !matches!(routing.as_str(), "direct" | "orgii_managed") {
        return Err("Unsupported routing mode".into());
    }
    verify_installed_version(&agent_name).await?;
    let connection = selected(&agent_name, &key_id, Some(&model))?;
    require_receipt(&connection, receipt.as_deref())?;
    if routing == "orgii_managed" {
        return crate::cli_managed_proxy::cli_config_enable_orgii_managed(
            agent_name,
            Some(key_id),
            Some(model),
            false,
            Some(expected_hashes),
        )
        .await;
    }
    tokio::task::spawn_blocking(move || {
        // Resolve again at the write boundary; key changes invalidate the receipt.
        let connection = selected(&agent_name, &key_id, Some(&model))?;
        require_receipt(&connection, receipt.as_deref())?;
        agent_cli::managed_config::enable_direct(
            &agent_name,
            DirectConnection {
                key_id: connection.key_id,
                provider: connection.provider,
                model: connection.model,
                base_url: connection.base_url,
                api_key: connection.api_key,
            },
            Some(&expected_hashes),
        )
    })
    .await
    .map_err(|_| "Connection apply failed")?
}

// Existing managed command callers share the same validation gate. A successful
// explicit test authorizes this exact credential/endpoint/model revision briefly.
pub(crate) fn authorize_managed(
    agent: &str,
    key_id: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    if !matches!(agent, "claude_code" | "codex") {
        return Ok(());
    }
    let connection = selected(agent, key_id.ok_or("Select a connection")?, model)?;
    if !connection.requires_test {
        return Ok(());
    }
    let receipts = RECEIPTS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Connection receipts unavailable")?;
    if receipts
        .values()
        .any(|(revision, time)| revision == &connection.revision && time.elapsed() < RECEIPT_TTL)
    {
        return Ok(());
    }
    Err("Test this endpoint in Harness connections before enabling it".into())
}

async fn verify_installed_version(agent: &str) -> Result<(), String> {
    use integrations::cli_binary_resolver::{
        probe_cli_binary_version, resolve_cli_binary_for_registry_name,
    };
    let binary = resolve_cli_binary_for_registry_name(agent).ok_or("Unsupported harness")?;
    if !binary.installed() {
        return Err("Install this harness before configuring a connection".into());
    }
    let probe = probe_cli_binary_version(&binary).await;
    let version = probe
        .version
        .ok_or("Cannot verify the installed harness version")?;
    let numbers = version
        .trim_start_matches('v')
        .split('.')
        .take(3)
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Unrecognized harness version; update to a stable release")?;
    let minimum = if agent == "codex" {
        [0, 148, 0]
    } else {
        [2, 1, 238]
    };
    if numbers.len() != 3 || numbers.as_slice() < minimum.as_slice() {
        return Err(format!(
            "Update {agent} to {}.{}.{} or newer before using native connections",
            minimum[0], minimum[1], minimum[2]
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use key_vault::key_store::{ModelKey, ModelType, ProviderProtocol};

    #[test]
    fn third_party_apply_requires_unexpired_evidence_for_the_same_credential_and_model() {
        let mut key = ModelKey::new(ModelType::CustomApi);
        key.api_key = Some("synthetic-fixture-key".into());
        key.base_url = Some("https://gateway.example/v1".into());
        key.protocol = Some(ProviderProtocol::OpenAi);
        key.available_models = vec!["first".into(), "second".into()];
        let connection = resolve("codex", &key, Some("first")).unwrap();
        assert!(require_receipt(&connection, None).is_err());
        let token = uuid::Uuid::new_v4().to_string();
        let receipts = RECEIPTS.get_or_init(Default::default);
        receipts
            .lock()
            .unwrap()
            .insert(token.clone(), (connection.revision.clone(), Instant::now()));
        assert!(require_receipt(&connection, Some(&token)).is_ok());
        assert!(require_receipt(
            &resolve("codex", &key, Some("second")).unwrap(),
            Some(&token)
        )
        .is_err());
        key.api_key = Some("changed-fixture-key".into());
        assert!(require_receipt(
            &resolve("codex", &key, Some("first")).unwrap(),
            Some(&token)
        )
        .is_err());
        receipts.lock().unwrap().insert(
            token.clone(),
            (connection.revision.clone(), Instant::now() - RECEIPT_TTL),
        );
        assert!(require_receipt(&connection, Some(&token)).is_err());
        receipts.lock().unwrap().remove(&token);
    }
}
