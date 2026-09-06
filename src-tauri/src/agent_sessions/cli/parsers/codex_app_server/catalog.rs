//! Supported Codex app-server registration for provider-native continuations.
//!
//! A rollout file alone is not a Codex App conversation: the App reads its
//! catalog through the app-server, and intentionally hides catalog rows that
//! have never acquired a user turn.  This module owns the supported JSON-RPC
//! path used to create/resume the real profile and to inject canonical raw
//! response items.  It never reads or writes Codex's private SQLite state.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CODEX_NATIVE_MODEL_PROVIDER: &str = "openai";

fn native_codex_app_server_command() -> PathBuf {
    let mut preferred = Vec::new();
    if let Some(explicit) = std::env::var_os("ORGII_NATIVE_CODEX_APP_BINARY") {
        preferred.push(PathBuf::from(explicit));
    }

    #[cfg(target_os = "macos")]
    {
        preferred.extend([
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
            PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        ]);
        if let Some(home) = dirs::home_dir() {
            preferred.push(home.join("Applications/ChatGPT.app/Contents/Resources/codex"));
            preferred.push(home.join("Applications/Codex.app/Contents/Resources/codex"));
        }
    }

    // A machine without the desktop App can still use a compatible Codex CLI
    // native store. Keep that fallback explicit and free of runner profile
    // env/argument overrides.
    PathBuf::from(
        integrations::cli_binary_resolver::resolve_cli_binary_command_preferring(
            integrations::cli_binary_resolver::CliBinaryId::Codex,
            preferred,
        ),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexCatalogEntry {
    pub id: String,
    pub path: PathBuf,
    pub title: String,
    pub cwd: PathBuf,
    pub model_provider: String,
}
fn with_rpc<T>(
    codex_home: &Path,
    cwd: &Path,
    operation: impl FnOnce(
        &tokio::runtime::Runtime,
        &mut super::CodexAppServerRpcClient,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("create Codex app-server runtime: {error}"))?;
    let command = native_codex_app_server_command();
    let mut client = runtime.block_on(super::CodexAppServerRpcClient::launch(
        &command, codex_home, cwd,
    ))?;
    operation(&runtime, &mut client)
}

fn request(
    runtime: &tokio::runtime::Runtime,
    client: &mut super::CodexAppServerRpcClient,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    runtime.block_on(client.request(method, params, REQUEST_TIMEOUT))
}
fn entry_from_thread(thread: &Value) -> Result<CodexCatalogEntry, String> {
    let id = thread["id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Codex app-server thread has no id".to_string())?;
    let path = thread["path"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Codex app-server thread {id} has no rollout path"))?;
    let title = thread["name"]
        .as_str()
        .or_else(|| thread["title"].as_str())
        .unwrap_or_default();
    let cwd = thread["cwd"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Codex app-server thread {id} has no cwd"))?;
    let model_provider = thread["modelProvider"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Codex app-server thread {id} has no model provider"))?;
    Ok(CodexCatalogEntry {
        id: id.to_string(),
        path: PathBuf::from(path),
        title: title.to_string(),
        cwd: PathBuf::from(cwd),
        model_provider: model_provider.to_string(),
    })
}

fn effective_model_provider(
    runtime: &tokio::runtime::Runtime,
    client: &mut super::CodexAppServerRpcClient,
    cwd: &Path,
) -> Result<String, String> {
    let result = request(
        runtime,
        client,
        "config/read",
        json!({"cwd": cwd, "includeLayers": false}),
    )?;
    Ok(allowlisted_native_model_provider(&result))
}

fn allowlisted_native_model_provider(config_result: &Value) -> String {
    let configured = config_result["config"]["model_provider"]
        .as_str()
        .filter(|value| !value.is_empty())
        // `openai` is Codex's built-in provider when config.toml omits an
        // explicit provider. Keep that default local to the native profile;
        // never borrow the ORGII runner profile's custom provider here.
        .unwrap_or(CODEX_NATIVE_MODEL_PROVIDER);
    if configured != CODEX_NATIVE_MODEL_PROVIDER {
        tracing::warn!(
            configured_provider = configured,
            native_provider = CODEX_NATIVE_MODEL_PROVIDER,
            "ignoring non-native Codex runner provider while publishing App catalog"
        );
    }
    // Native App artifacts must only reference providers the real Codex home
    // can always resolve. Session-scoped ORGII compatible providers belong to
    // the isolated runner profile and must never leak into this catalog.
    CODEX_NATIVE_MODEL_PROVIDER.to_string()
}

fn validate_target_profile(
    entry: CodexCatalogEntry,
    expected_id: &str,
    expected_cwd: &Path,
    expected_title: &str,
    expected_provider: &str,
) -> Result<CodexCatalogEntry, String> {
    if entry.id != expected_id
        || !paths_have_same_identity(&entry.cwd, expected_cwd)
        || entry.title != expected_title
        || entry.model_provider != expected_provider
    {
        return Err(format!(
            "Codex native profile mismatch: expected id={expected_id} cwd={} title={expected_title:?} provider={expected_provider:?}, got id={} cwd={} title={:?} provider={:?}",
            expected_cwd.display(),
            entry.id,
            entry.cwd.display(),
            entry.title,
            entry.model_provider
        ));
    }
    Ok(entry)
}

fn paths_have_same_identity(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn read_thread(
    runtime: &tokio::runtime::Runtime,
    client: &mut super::CodexAppServerRpcClient,
    thread_id: &str,
) -> Result<CodexCatalogEntry, String> {
    let result = request(
        runtime,
        client,
        "thread/read",
        // Catalog validation only needs id/path/name/cwd/provider metadata.
        // Loading every turn here makes a runtime switch O(full transcript)
        // for exactly the large conversations this adapter must support.
        json!({"threadId": thread_id, "includeTurns": false}),
    )?;
    entry_from_thread(&result["thread"])
}

fn set_thread_name(
    runtime: &tokio::runtime::Runtime,
    client: &mut super::CodexAppServerRpcClient,
    thread_id: &str,
    title: &str,
) -> Result<(), String> {
    request(
        runtime,
        client,
        "thread/name/set",
        json!({"threadId": thread_id, "name": title}),
    )?;
    Ok(())
}

fn inject_items(
    runtime: &tokio::runtime::Runtime,
    client: &mut super::CodexAppServerRpcClient,
    thread_id: &str,
    items: &[Value],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    request(
        runtime,
        client,
        "thread/inject_items",
        json!({"threadId": thread_id, "items": items}),
    )?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SuffixApplication {
    Missing,
    AlreadyApplied,
}

fn response_item_identity(item: &Value) -> Option<String> {
    let item_type = item["type"].as_str()?;
    match item_type {
        "message" => item["id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(|id| format!("{item_type}:{id}")),
        "function_call" | "function_call_output" => item["call_id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(|call_id| format!("{item_type}:{call_id}")),
        _ => None,
    }
}

fn inspect_suffix_application(
    path: &Path,
    expected_items: &[Value],
) -> Result<SuffixApplication, String> {
    if expected_items.is_empty() {
        return Ok(SuffixApplication::AlreadyApplied);
    }
    let mut expected = HashMap::with_capacity(expected_items.len());
    for item in expected_items {
        let identity = response_item_identity(item).ok_or_else(|| {
            format!(
                "Codex native suffix item has no stable identity: type={:?}",
                item["type"].as_str()
            )
        })?;
        if expected.insert(identity.clone(), item.clone()).is_some() {
            return Err(format!(
                "Codex native suffix contains duplicate stable identity {identity}"
            ));
        }
    }

    let file = std::fs::File::open(path)
        .map_err(|error| format!("open Codex rollout {}: {error}", path.display()))?;
    let mut found = HashSet::with_capacity(expected.len());
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| {
            format!(
                "read Codex rollout {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<Value>(&line).map_err(|error| {
            format!(
                "decode Codex rollout {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        if record["type"] != "response_item" {
            continue;
        }
        let Some(identity) = response_item_identity(&record["payload"]) else {
            continue;
        };
        if let Some(expected_item) = expected.get(&identity) {
            if &record["payload"] != expected_item {
                return Err(format!(
                    "Codex rollout {} contains stable suffix identity {identity} with conflicting content",
                    path.display()
                ));
            }
            if !found.insert(identity.clone()) {
                return Err(format!(
                    "Codex rollout {} contains duplicate stable suffix identity {identity}",
                    path.display()
                ));
            }
        }
    }

    if found.is_empty() {
        Ok(SuffixApplication::Missing)
    } else if found.len() == expected.len() {
        Ok(SuffixApplication::AlreadyApplied)
    } else {
        Err(format!(
            "Codex rollout {} contains {} of {} stable suffix items; refusing a mixed retry",
            path.display(),
            found.len(),
            expected.len()
        ))
    }
}

pub(crate) fn register_thread(
    codex_home: &Path,
    cwd: &Path,
    title: &str,
    items: &[Value],
) -> Result<CodexCatalogEntry, String> {
    with_rpc(codex_home, cwd, |runtime, client| {
        let model_provider = effective_model_provider(runtime, client, cwd)?;
        let result = request(
            runtime,
            client,
            "thread/start",
            json!({
                "cwd": cwd,
                "modelProvider": model_provider,
                "ephemeral": false,
                "historyMode": "legacy",
                "experimentalRawEvents": false
            }),
        )?;
        let started_id = result["thread"]["id"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "Codex app-server thread/start returned no thread id".to_string())?
            .to_string();
        let registered = (|| -> Result<CodexCatalogEntry, String> {
            set_thread_name(runtime, client, &started_id, title)?;
            let registered = read_thread(runtime, client, &started_id)?;
            let registered =
                validate_target_profile(registered, &started_id, cwd, title, &model_provider)?;
            // Injection is deliberately last. Once this request succeeds there
            // are no later fallible validation steps that could make a caller
            // retry and duplicate the same canonical suffix.
            inject_items(runtime, client, &started_id, items)?;
            Ok(registered)
        })();
        if registered.is_err() {
            let _ = request(
                runtime,
                client,
                "thread/archive",
                json!({"threadId": &started_id}),
            );
        }
        registered
    })
}

pub(crate) fn synchronize_thread(
    codex_home: &Path,
    path: &Path,
    expected_id: &str,
    cwd: &Path,
    title: &str,
    items: &[Value],
) -> Result<CodexCatalogEntry, String> {
    // Inspect the durable rollout before any app-server mutation. A timed-out
    // `thread/inject_items` may have committed even when ORGII lost the reply;
    // retries must therefore prove all-missing or all-applied, never inject a
    // mixed/unknown suffix blindly.
    let suffix_application = inspect_suffix_application(path, items)?;
    with_rpc(codex_home, cwd, |runtime, client| {
        let model_provider = effective_model_provider(runtime, client, cwd)?;
        let result = request(
            runtime,
            client,
            "thread/resume",
            json!({
                "threadId": expected_id,
                "path": path,
                "cwd": cwd,
                "modelProvider": model_provider
            }),
        )?;
        let resumed = entry_from_thread(&result["thread"])?;
        if resumed.id != expected_id {
            return Err(format!(
                "Codex resumed the wrong native thread: expected {expected_id}, got {}",
                resumed.id
            ));
        }
        set_thread_name(runtime, client, expected_id, title)?;
        let synchronized = read_thread(runtime, client, expected_id)?;
        let synchronized =
            validate_target_profile(synchronized, expected_id, cwd, title, &model_provider)?;
        // Keep injection as the terminal mutation. If its response is lost, the
        // next call re-inspects the durable rollout before deciding to inject.
        if suffix_application == SuffixApplication::Missing {
            inject_items(runtime, client, expected_id, items)?;
        }
        Ok(synchronized)
    })
}

pub(crate) fn archive_thread(
    codex_home: &Path,
    path: &Path,
    expected_id: &str,
    cwd: &Path,
) -> Result<(), String> {
    with_rpc(codex_home, cwd, |runtime, client| {
        let model_provider = effective_model_provider(runtime, client, cwd)?;
        let result = request(
            runtime,
            client,
            "thread/resume",
            json!({
                "threadId": expected_id,
                "path": path,
                "cwd": cwd,
                "modelProvider": model_provider
            }),
        )?;
        let resumed = entry_from_thread(&result["thread"])?;
        if resumed.id != expected_id {
            return Err(format!(
                "refusing to archive Codex thread {} while rolling back {expected_id}",
                resumed.id
            ));
        }
        request(
            runtime,
            client,
            "thread/archive",
            json!({"threadId": expected_id}),
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_thread_catalog_shape() {
        let entry = entry_from_thread(&json!({
            "id": "thread-1",
            "path": "/tmp/rollout-thread-1.jsonl",
            "name": "Native title",
            "cwd": "/tmp/repo",
            "modelProvider": "openai"
        }))
        .expect("catalog entry");
        assert_eq!(entry.id, "thread-1");
        assert_eq!(entry.title, "Native title");
        assert_eq!(entry.cwd, PathBuf::from("/tmp/repo"));
        assert_eq!(entry.model_provider, "openai");
    }

    #[test]
    fn rejects_catalog_rows_without_provider_identity() {
        let error = entry_from_thread(&json!({"cwd": "/tmp/repo"}))
            .expect_err("missing identity must fail");
        assert!(error.contains("no id"));
    }

    #[test]
    fn rejects_runner_provider_identity_in_native_profile() {
        let entry = CodexCatalogEntry {
            id: "thread-1".to_string(),
            path: PathBuf::from("/tmp/rollout-thread-1.jsonl"),
            title: "Native title".to_string(),
            cwd: PathBuf::from("/tmp/repo"),
            model_provider: "orgii_compatible".to_string(),
        };
        let error = validate_target_profile(
            entry,
            "thread-1",
            Path::new("/tmp/repo"),
            "Native title",
            "openai",
        )
        .expect_err("runner-only provider must not enter the native catalog");
        assert!(error.contains("orgii_compatible"));
        assert!(error.contains("openai"));
    }

    #[test]
    fn native_catalog_provider_is_a_builtin_allowlisted_identity() {
        assert_eq!(
            allowlisted_native_model_provider(&json!({
                "config": {"model_provider": "orgii_compatible"}
            })),
            "openai"
        );
        assert_eq!(
            allowlisted_native_model_provider(&json!({"config": {}})),
            "openai"
        );
    }

    #[test]
    fn suffix_inspection_distinguishes_missing_applied_and_mixed() {
        let temp = tempfile::tempdir().expect("temp Codex rollout root");
        let path = temp.path().join("rollout.jsonl");
        let expected = vec![
            json!({"type": "message", "id": "message-1"}),
            json!({"type": "function_call", "call_id": "call-1"}),
        ];
        let rollout = |items: &[Value]| {
            items
                .iter()
                .map(|payload| json!({"type": "response_item", "payload": payload}).to_string())
                .collect::<Vec<_>>()
                .join("\n")
        };

        std::fs::write(
            &path,
            rollout(&[json!({"type": "message", "id": "unrelated"})]),
        )
        .expect("write missing suffix fixture");
        assert_eq!(
            inspect_suffix_application(&path, &expected).expect("inspect missing suffix"),
            SuffixApplication::Missing
        );

        std::fs::write(&path, rollout(&expected[..1])).expect("write mixed suffix fixture");
        assert!(inspect_suffix_application(&path, &expected).is_err());

        std::fs::write(&path, rollout(&expected)).expect("write applied suffix fixture");
        assert_eq!(
            inspect_suffix_application(&path, &expected).expect("inspect applied suffix"),
            SuffixApplication::AlreadyApplied
        );
    }

    #[cfg(unix)]
    #[test]
    fn accepts_filesystem_equivalent_catalog_cwd() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("temp native catalog root");
        let canonical = temp.path().join("canonical-workspace");
        let alias = temp.path().join("workspace-alias");
        std::fs::create_dir(&canonical).expect("canonical workspace");
        symlink(&canonical, &alias).expect("workspace alias");
        let entry = CodexCatalogEntry {
            id: "thread-1".to_string(),
            path: temp.path().join("rollout-thread-1.jsonl"),
            title: "Native title".to_string(),
            cwd: alias,
            model_provider: "openai".to_string(),
        };

        validate_target_profile(entry, "thread-1", &canonical, "Native title", "openai")
            .expect("filesystem-equivalent cwd must preserve native identity");
    }
}
