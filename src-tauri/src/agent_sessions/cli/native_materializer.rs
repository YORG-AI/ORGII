//! Structured conversation -> provider-native transcript materialization.
//!
//! This is deliberately not a prompt bridge. Every supported target gets the
//! role/tool records its own resume protocol reads. Unsupported targets fail
//! closed before a process is launched.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use agent_core::session::persistence::{
    MaterializedHistoryContent, MaterializedHistoryRole, MaterializedHistorySeed,
};
use agent_core::session::{ScheduledKind, ScheduledMessage};
use agent_core::state::AgentAppState;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use core_types::activity::ActivityChunk;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;
use uuid::Uuid;

#[cfg(test)]
use super::native_ir::native_item_semantically_equal;
pub use super::native_ir::NativeConversationItem;
use super::native_ir::{
    native_items_from_agent_history, native_items_from_chunks, provider_portable_append_suffix,
    validate_items, MAX_ITEMS,
};
use super::native_store::{
    append_suffix_atomically, copy_file_atomically, lock_claude_transcript,
    native_transcript_revision, replace_file_link_atomically, write_file_atomically,
};
use super::native_transcript::TRANSCRIPT_SOURCE_NATIVE;
use super::parsers::codex_app_server as codex_native_catalog;
use super::persistence;

const CODEX_NATIVE_PATH_CACHE_MAX_ENTRIES: usize = 512;
const CLAUDE_PROJECT_INDEX_VERSION: u64 = 1;
const CLAUDE_DESKTOP_ACCOUNT_SCAN_LIMIT: usize = 64;
const CLAUDE_DESKTOP_PROJECT_SCAN_LIMIT: usize = 2_048;
const CLAUDE_DESKTOP_METADATA_SCAN_LIMIT: usize = 10_000;
// Codex stores rollouts in a date-sharded directory tree. Resolving the same
// native UUID by walking that tree on every turn makes a long-running session
// progressively more expensive even though its path is immutable. Cache only
// successful resolutions and validate the provider file still exists before
// reusing one; deletion or profile cleanup naturally falls back to discovery.
static CODEX_NATIVE_PATH_CACHE: LazyLock<Mutex<HashMap<(String, String), NativeTranscriptPaths>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Claude's project index is shared by every ORG2 instance that points at the
/// same native history root. The adjacent advisory lock keeps the complete
/// read-modify-write transaction ordered across independently launched ORG2
/// processes. Locking
/// the index file itself would be incorrect because `atomic_json` replaces its
/// inode.
struct ClaudeProjectIndexGuard {
    lock_file: fs::File,
}

impl Drop for ClaudeProjectIndexGuard {
    fn drop(&mut self) {
        // Releasing an advisory lock during Drop is best effort. Closing the
        // descriptor releases it as well, including after an unlock error.
        let _ = self.lock_file.unlock();
    }
}

fn lock_claude_project_index(index_path: &Path) -> Result<ClaudeProjectIndexGuard, String> {
    let parent = index_path.parent().ok_or_else(|| {
        format!(
            "Claude project index has no parent directory: {}",
            index_path.display()
        )
    })?;

    let lock_path = parent.join(".orgii-sessions-index.lock");
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| {
            format!(
                "open Claude project index lock {}: {error}",
                lock_path.display()
            )
        })?;
    lock_file
        .lock()
        .map_err(|error| format!("lock Claude project index {}: {error}", lock_path.display()))?;
    Ok(ClaudeProjectIndexGuard { lock_file })
}

#[derive(Debug, Clone)]
struct NativeTranscriptPaths {
    /// Durable transcript discovered by the provider's real native App.
    native_path: PathBuf,
    /// Account-profile alias used by ORG2's isolated provider runner.
    runner_path: PathBuf,
}

/// Filesystem/native-binding mutations need both short lifecycle exclusion and
/// provider-identity exclusion. Never wait for identity while a runner is
/// alive: its finalizer already owns identity and briefly takes control for
/// terminal persistence, so doing so would invert the lock order.
struct NativeMutationGuards {
    _control: tokio::sync::OwnedMutexGuard<()>,
    _identity: tokio::sync::OwnedMutexGuard<()>,
}

async fn lock_idle_native_mutation(session_id: &str) -> Result<NativeMutationGuards, String> {
    let control = super::session_runner::session_control_lock(session_id)
        .await
        .lock_owned()
        .await;
    let has_live_runner = {
        let sessions = super::session_runner::RUNNING_SESSIONS.lock().await;
        sessions
            .get(session_id)
            .is_some_and(|handle| !handle.is_finished())
    };
    if has_live_runner {
        return Err(format!(
            "Session {session_id} still has a running provider turn"
        ));
    }
    let identity = super::session_runner::session_identity_lock(session_id)
        .await
        .lock_owned()
        .await;
    Ok(NativeMutationGuards {
        _control: control,
        _identity: identity,
    })
}

/// Run an Agent transcript mutation through the same FIFO owner as ordinary
/// Agent turns. This is deliberately separate from the CLI lock path: an
/// Agent session has no CLI runner entry, so taking CLI locks provides no
/// exclusion from its live `DialogScheduler` turn.
async fn run_agent_native_maintenance<F>(
    state: &AgentAppState,
    session_id: String,
    operation: F,
) -> Result<NativeMaterializationReceipt, String>
where
    F: FnOnce() -> Result<NativeMaterializationReceipt, String> + Send + 'static,
{
    let session =
        agent_core::state::commands::prepare_session_for_scheduler_maintenance(state, &session_id)
            .await?;
    enqueue_agent_native_maintenance(session, session_id, operation).await
}

async fn enqueue_agent_native_maintenance<F>(
    session: Arc<agent_core::state::AgentSession>,
    session_id: String,
    operation: F,
) -> Result<NativeMaterializationReceipt, String>
where
    F: FnOnce() -> Result<NativeMaterializationReceipt, String> + Send + 'static,
{
    let (result_tx, result_rx) = oneshot::channel();
    let maintenance_id = format!("native-materialization-{}", Uuid::new_v4());
    session
        .scheduler
        .enqueue(ScheduledMessage {
            kind: ScheduledKind::Maintenance,
            message_id: maintenance_id,
            generation: 0,
            client_message_id: None,
            turn_intent_id: String::new(),
            org_run_id: None,
            content: "[native transcript materialization]".to_string(),
            execute: Box::new(move || {
                Box::pin(async move {
                    let result = tokio::task::spawn_blocking(operation)
                        .await
                        .map_err(|error| format!("native materialization task failed: {error}"))
                        .and_then(|result| result);
                    let _ = result_tx.send(result);
                    // Maintenance failures travel through the command reply;
                    // returning Ok prevents the scheduler from manufacturing
                    // a user-visible Agent error for a non-turn operation.
                    Ok(String::new())
                })
            }),
        })
        .await?;
    result_rx.await.map_err(|_| {
        format!("native materialization scheduler stopped before completing {session_id}")
    })?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMaterializationReceipt {
    native_session_id: String,
    item_count: usize,
}

fn authoritative_native_items(session_id: &str) -> Result<Vec<NativeConversationItem>, String> {
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        let session = persistence::get_session(session_id)
            .map_err(|error| format!("load CLI session {session_id}: {error}"))?
            .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
        let account_id = session
            .account_id
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        let native_id = persistence::get_cli_session_id_for_account(session_id, account_id)
            .map_err(|error| format!("read native binding for {session_id}: {error}"))?
            .ok_or_else(|| format!("CLI session {session_id} has no native resume binding"))?;
        let chunks = load_materialized_cli_transcript(&session, &native_id)?
            .ok_or_else(|| format!("provider-native transcript {native_id} was not found"))?;
        Ok(native_items_from_chunks(&chunks))
    } else {
        let history = agent_core::session::persistence::load_llm_history(session_id)
            .map_err(|error| format!("load native Agent transcript {session_id}: {error}"))?;
        Ok(native_items_from_agent_history(&history))
    }
}

fn authoritative_append_suffix(
    session_id: &str,
    complete: &[NativeConversationItem],
) -> Result<Vec<NativeConversationItem>, String> {
    let authoritative = authoritative_native_items(session_id)?;
    provider_portable_append_suffix(&authoritative, complete).map_err(|reason| {
        format!(
            "provider-native transcript is not a semantic prefix of the canonical conversation: native={} canonical={} ({reason})",
            authoritative.len(),
            complete.len()
        )
    })
}

fn atomic_jsonl(path: &Path, records: &[Value]) -> Result<(), String> {
    write_file_atomically(path, "jsonl.tmp", "native transcript", |file| {
        for record in records {
            serde_json::to_writer(&mut *file, record)
                .map_err(|error| format!("serialize native transcript: {error}"))?;
            std::io::Write::write_all(file, b"\n")
                .map_err(|error| format!("serialize native transcript: {error}"))?;
        }
        Ok(())
    })
}

fn serialize_jsonl(records: &[Value]) -> Result<Vec<u8>, String> {
    let mut payload = Vec::new();
    for record in records {
        serde_json::to_writer(&mut payload, record)
            .map_err(|err| format!("serialize native transcript suffix: {err}"))?;
        payload.push(b'\n');
    }
    Ok(payload)
}

fn remove_file_if_present(path: &Path) -> Result<bool, String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "remove native transcript {}: {error}",
            path.display()
        )),
    }
}

fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    write_file_atomically(path, "json.tmp", "native metadata", |file| {
        serde_json::to_writer_pretty(&mut *file, value)
            .map_err(|error| format!("serialize native metadata: {error}"))?;
        std::io::Write::write_all(file, b"\n")
            .map_err(|error| format!("serialize native metadata: {error}"))
    })
}

fn replace_runner_link(native_path: &Path, runner_path: &Path) -> Result<(), String> {
    replace_file_link_atomically(native_path, runner_path, "native runner transcript link")
}

fn validate_provider_jsonl(path: &Path, expected_native_id: &str) -> Result<(), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("open provider transcript {}: {error}", path.display()))?;
    let mut records = 0usize;
    let mut identity_seen = false;
    for (index, line) in BufReader::new(file).lines().enumerate() {
        if index >= MAX_ITEMS {
            return Err(format!(
                "provider transcript {} exceeds {MAX_ITEMS} records",
                path.display()
            ));
        }
        let line =
            line.map_err(|error| format!("read provider transcript {}: {error}", path.display()))?;
        if line.trim().is_empty() {
            continue;
        }
        let record: Value = serde_json::from_str(&line).map_err(|error| {
            format!(
                "provider transcript {} has invalid JSON at line {}: {error}",
                path.display(),
                index + 1
            )
        })?;
        records += 1;
        identity_seen |= record["sessionId"].as_str() == Some(expected_native_id)
            || record["session_id"].as_str() == Some(expected_native_id)
            || record["payload"]["session_id"].as_str() == Some(expected_native_id)
            || record["payload"]["id"].as_str() == Some(expected_native_id);
    }
    if records == 0 {
        return Err(format!("provider transcript {} is empty", path.display()));
    }
    if !identity_seen {
        return Err(format!(
            "provider transcript {} does not contain expected native id {expected_native_id}",
            path.display()
        ));
    }
    Ok(())
}

fn file_is_byte_prefix(prefix: &Path, complete: &Path) -> Result<bool, String> {
    let mut prefix_file = fs::File::open(prefix)
        .map_err(|error| format!("open transcript {}: {error}", prefix.display()))?;
    let mut complete_file = fs::File::open(complete)
        .map_err(|error| format!("open transcript {}: {error}", complete.display()))?;
    let mut left = [0u8; 64 * 1024];
    let mut right = [0u8; 64 * 1024];
    loop {
        let left_len = prefix_file
            .read(&mut left)
            .map_err(|error| format!("read transcript {}: {error}", prefix.display()))?;
        if left_len == 0 {
            return Ok(true);
        }
        let mut right_len = 0usize;
        while right_len < left_len {
            let read = complete_file
                .read(&mut right[right_len..left_len])
                .map_err(|error| format!("read transcript {}: {error}", complete.display()))?;
            if read == 0 {
                return Ok(false);
            }
            right_len += read;
        }
        if left[..left_len] != right[..left_len] {
            return Ok(false);
        }
    }
}

fn copy_transcript_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    copy_file_atomically(source, destination, "native transcript")
}

/// Converge legacy profile-only and dual-root layouts on one durable native
/// App transcript plus one account-profile runner alias. Returns true only
/// when runner bytes were promoted into the native App store.
fn ensure_durable_runner_alias(
    paths: &NativeTranscriptPaths,
    expected_native_id: &str,
) -> Result<bool, String> {
    if paths.native_path == paths.runner_path {
        validate_provider_jsonl(&paths.native_path, expected_native_id)?;
        return Ok(false);
    }

    let native_exists = paths.native_path.is_file();
    let runner_exists = paths.runner_path.is_file();
    if !native_exists && !runner_exists {
        return Err(format!(
            "provider-native transcript {expected_native_id} was not found"
        ));
    }
    if !native_exists {
        validate_provider_jsonl(&paths.runner_path, expected_native_id)?;
        copy_transcript_atomically(&paths.runner_path, &paths.native_path)?;
        replace_runner_link(&paths.native_path, &paths.runner_path)?;
        return Ok(true);
    }
    if !runner_exists {
        replace_runner_link(&paths.native_path, &paths.runner_path)?;
        return Ok(false);
    }
    if paths_match(&paths.native_path, &paths.runner_path) {
        return Ok(false);
    }

    validate_provider_jsonl(&paths.runner_path, expected_native_id)?;
    if file_is_byte_prefix(&paths.native_path, &paths.runner_path)? {
        copy_transcript_atomically(&paths.runner_path, &paths.native_path)?;
        replace_runner_link(&paths.native_path, &paths.runner_path)?;
        return Ok(true);
    }
    if file_is_byte_prefix(&paths.runner_path, &paths.native_path)? {
        replace_runner_link(&paths.native_path, &paths.runner_path)?;
        return Ok(false);
    }
    Err(format!(
        "provider-native transcript conflict for {expected_native_id}: native App and isolated runner both advanced"
    ))
}

fn write_native_store_jsonl(
    paths: &NativeTranscriptPaths,
    records: &[Value],
) -> Result<(), String> {
    atomic_jsonl(&paths.native_path, records)?;
    replace_runner_link(&paths.native_path, &paths.runner_path)
}

fn stable_uuid(namespace: &str, native_id: &str, item_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(namespace.as_bytes());
    digest.update([0]);
    digest.update(native_id.as_bytes());
    digest.update([0]);
    digest.update(item_id.as_bytes());
    let hash = digest.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn image_block(data_url: &str) -> Result<Value, String> {
    let Some((header, data)) = data_url.split_once(',') else {
        return Err("historical image data URL is malformed".to_string());
    };
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .filter(|value| value.starts_with("image/"))
        .ok_or_else(|| "historical image must be a base64 image data URL".to_string())?;
    Ok(json!({
        "type": "image",
        "source": {"type": "base64", "media_type": media_type, "data": data}
    }))
}

fn native_agent_seeds(
    target_session_id: &str,
    items: &[NativeConversationItem],
) -> Vec<MaterializedHistorySeed> {
    items
        .iter()
        .map(|item| match item {
            NativeConversationItem::Message {
                id,
                role,
                text,
                images,
                created_at,
                turn_id,
            } => MaterializedHistorySeed {
                id: native_agent_row_id(target_session_id, id, turn_id.as_deref()),
                created_at: created_at.clone(),
                content: MaterializedHistoryContent::Message {
                    role: if role == "user" {
                        MaterializedHistoryRole::User
                    } else {
                        MaterializedHistoryRole::Assistant
                    },
                    text: text.clone(),
                    images: images.clone(),
                },
            },
            NativeConversationItem::ToolCall {
                id,
                call_id,
                name,
                arguments,
                created_at,
            } => MaterializedHistorySeed {
                id: native_agent_row_id(target_session_id, id, None),
                created_at: created_at.clone(),
                content: MaterializedHistoryContent::ToolCall {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    arguments: arguments.clone(),
                },
            },
            NativeConversationItem::ToolResult {
                id,
                call_id,
                name,
                output,
                created_at,
                ..
            } => MaterializedHistorySeed {
                id: native_agent_row_id(target_session_id, id, None),
                created_at: created_at.clone(),
                content: MaterializedHistoryContent::ToolResult {
                    call_id: call_id.clone(),
                    name: name.clone(),
                    output: output.clone(),
                },
            },
            NativeConversationItem::ContextSummary {
                id,
                summary,
                created_at,
            } => MaterializedHistorySeed {
                id: native_agent_row_id(target_session_id, id, None),
                created_at: created_at.clone(),
                content: MaterializedHistoryContent::Message {
                    role: MaterializedHistoryRole::User,
                    text: summary.clone(),
                    images: Vec::new(),
                },
            },
        })
        .collect()
}

fn native_agent_row_id(target_session_id: &str, source_id: &str, turn_id: Option<&str>) -> String {
    let source = URL_SAFE_NO_PAD.encode(source_id.as_bytes());
    // The target is part of the stable suffix because agent_messages.id is a
    // database-wide primary key: importing the same canonical source into two
    // different execution Sessions must not collide, while retrying the same
    // target append must resolve to the exact same durable rows.
    let target_tag = stable_uuid("orgii-agent-native-row", target_session_id, source_id);
    match turn_id.filter(|value| !value.is_empty()) {
        Some(turn_id) => format!(
            "org2-turn-v1.{}.{}.{}",
            URL_SAFE_NO_PAD.encode(turn_id.as_bytes()),
            source,
            target_tag
        ),
        None => format!("org2-native-v1.{source}.{target_tag}"),
    }
}

fn sanitize_claude_project_name(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn claude_native_paths(
    account_id: Option<&str>,
    cwd: &Path,
    native_id: &str,
) -> NativeTranscriptPaths {
    let relative = PathBuf::from("projects")
        .join(sanitize_claude_project_name(cwd))
        .join(format!("{native_id}.jsonl"));
    let native_path = app_paths::native_transcript_home_dir()
        .join(".claude")
        .join(&relative);
    NativeTranscriptPaths {
        runner_path: account_id
            .map(|account_id| app_paths::claude_code_cli_profile_dir(account_id).join(relative))
            .unwrap_or_else(|| native_path.clone()),
        native_path,
    }
}

/// Resolve an already-bound Claude transcript without assuming the current
/// account-profile layout is the only layout that has ever been published.
///
/// The returned pair is canonical even when only the profile-only path created
/// by an intermediate release exists. Mutation code can then promote that file
/// without teaching every caller a second storage layout.
fn existing_claude_native_paths(
    account_id: Option<&str>,
    cwd: &Path,
    native_id: &str,
) -> Option<NativeTranscriptPaths> {
    let paths = claude_native_paths(account_id, cwd, native_id);
    (paths.native_path.is_file() || paths.runner_path.is_file()).then_some(paths)
}

fn codex_profile_sessions_root(account_id: &str) -> PathBuf {
    app_paths::codex_cli_profile_dir(account_id).join("sessions")
}

fn codex_native_app_home() -> PathBuf {
    app_paths::native_transcript_home_dir().join(".codex")
}

fn codex_native_app_sessions_root() -> PathBuf {
    codex_native_app_home().join("sessions")
}

fn codex_native_paths_for_relative(account_id: &str, relative: &Path) -> NativeTranscriptPaths {
    NativeTranscriptPaths {
        native_path: codex_native_app_sessions_root().join(relative),
        runner_path: codex_profile_sessions_root(account_id).join(relative),
    }
}

fn cache_codex_native_paths(account_id: &str, native_id: &str, paths: &NativeTranscriptPaths) {
    let Ok(mut cache) = CODEX_NATIVE_PATH_CACHE.lock() else {
        return;
    };
    let key = (account_id.to_string(), native_id.to_string());
    if cache.len() >= CODEX_NATIVE_PATH_CACHE_MAX_ENTRIES && !cache.contains_key(&key) {
        if let Some(evicted) = cache.keys().next().cloned() {
            cache.remove(&evicted);
        }
    }
    cache.insert(key, paths.clone());
}

fn existing_codex_native_paths(
    account_id: &str,
    native_id: &str,
) -> Result<Option<NativeTranscriptPaths>, String> {
    let cache_key = (account_id.to_string(), native_id.to_string());
    if let Some(paths) = CODEX_NATIVE_PATH_CACHE
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        if paths.native_path.is_file() || paths.runner_path.is_file() {
            return Ok(Some(paths));
        }
        if let Ok(mut cache) = CODEX_NATIVE_PATH_CACHE.lock() {
            cache.remove(&cache_key);
        }
    }

    let profile_root = codex_profile_sessions_root(account_id);
    let native_app_root = codex_native_app_sessions_root();
    let found = find_codex_materialization(&native_app_root, native_id)?
        .map(|path| (path, native_app_root));
    let (found, root) = match found {
        Some(found) => found,
        None => match find_codex_materialization(&profile_root, native_id)? {
            Some(path) => (path, profile_root),
            None => return Ok(None),
        },
    };
    let relative = found.strip_prefix(&root).map_err(|error| {
        format!(
            "resolved Codex rollout {} outside scanned root {}: {error}",
            found.display(),
            root.display()
        )
    })?;
    let paths = codex_native_paths_for_relative(account_id, relative);
    cache_codex_native_paths(account_id, native_id, &paths);
    Ok(Some(paths))
}

fn registered_codex_native_paths(
    account_id: &str,
    native_path: &Path,
) -> Result<NativeTranscriptPaths, String> {
    let root = codex_native_app_sessions_root();
    let relative = match native_path.strip_prefix(&root) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => {
            let canonical_root = fs::canonicalize(&root).map_err(|error| {
                format!(
                    "canonicalize Codex sessions root {}: {error}",
                    root.display()
                )
            })?;
            let canonical_path = fs::canonicalize(native_path).map_err(|error| {
                format!(
                    "canonicalize Codex rollout {}: {error}",
                    native_path.display()
                )
            })?;
            canonical_path
                .strip_prefix(&canonical_root)
                .map(Path::to_path_buf)
                .map_err(|error| {
                    format!(
                        "Codex app-server registered rollout outside the native App store: path={} root={} ({error})",
                        native_path.display(),
                        root.display()
                    )
                })?
        }
    };
    Ok(codex_native_paths_for_relative(account_id, &relative))
}

/// Resolve one freshly bound provider transcript directly by its exact UUID.
///
/// The imported-history cache is eventually refreshed and remains the normal
/// reader. Materialization, however, must prove its write synchronously before
/// the provider process starts. Requiring a global history scan here makes a
/// single continuation depend on every unrelated native transcript on disk.
fn materialized_cli_transcript_paths(
    session: &persistence::CodeSession,
    native_id: &str,
) -> Result<Option<(String, NativeTranscriptPaths)>, String> {
    let agent = session.cli_agent_type.as_deref().unwrap_or_default();
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let cwd = execution_cwd(session)?;
    let paths = match agent {
        "claude_code" => {
            let Some(paths) = existing_claude_native_paths(account_id, &cwd, native_id) else {
                return Ok(None);
            };
            paths
        }
        "codex" => {
            let account_id = account_id.ok_or_else(|| {
                "native Codex transcript read requires an explicit local account".to_string()
            })?;
            let Some(paths) = existing_codex_native_paths(account_id, native_id)? else {
                return Ok(None);
            };
            paths
        }
        _ => return Ok(None),
    };
    Ok(Some((agent.to_string(), paths)))
}

fn materialized_cli_transcript_path(
    session: &persistence::CodeSession,
    native_id: &str,
) -> Result<Option<(String, PathBuf)>, String> {
    let Some((agent, paths)) = materialized_cli_transcript_paths(session, native_id)? else {
        return Ok(None);
    };
    let Some(path) = preferred_materialized_transcript_path(&paths)? else {
        return Ok(None);
    };
    Ok(Some((agent, path.to_path_buf())))
}

/// Resolve only the transcript path the vendor's native App owns.
///
/// The isolated runner alias is valid for ORG2 resume/replay, but cannot make
/// an official App deep link open successfully. App-open availability must
/// therefore require this exact native-store copy.
pub(crate) fn native_app_transcript_path(
    session: &persistence::CodeSession,
    native_id: &str,
) -> Result<Option<PathBuf>, String> {
    let Some((_agent, paths)) = materialized_cli_transcript_paths(session, native_id)? else {
        return Ok(None);
    };
    Ok(paths.native_path.is_file().then_some(paths.native_path))
}

pub(super) fn load_materialized_cli_transcript(
    session: &persistence::CodeSession,
    native_id: &str,
) -> Result<Option<Vec<ActivityChunk>>, String> {
    let Some((agent, path)) = materialized_cli_transcript_path(session, native_id)? else {
        return Ok(None);
    };
    let chunks = match agent.as_str() {
        "claude_code" => {
            orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                &session.session_id,
                &path,
            )?
        }
        "codex" => orgtrack_core::sources::codex::app::load_codex_app_from_path(
            &session.session_id,
            &path,
        )?,
        _ => unreachable!("unsupported targets returned above"),
    };
    Ok(Some(chunks))
}

/// Current revision of the exact provider transcript selected by the same
/// resolver as [`load_materialized_cli_transcript`].
pub(super) fn materialized_cli_transcript_revision(
    session: &persistence::CodeSession,
    native_id: &str,
) -> Result<Option<String>, String> {
    let Some((_agent, path)) = materialized_cli_transcript_path(session, native_id)? else {
        return Ok(None);
    };
    native_transcript_revision(&path).map(Some)
}

/// Resolve the authoritative copy without guessing from timestamps. Two
/// independent regular files are safe only when one is the exact byte-prefix
/// of the other; otherwise both sides advanced and the caller must fail closed.
fn preferred_materialized_transcript_path(
    paths: &NativeTranscriptPaths,
) -> Result<Option<&Path>, String> {
    let native_metadata = fs::metadata(&paths.native_path).ok();
    let runner_metadata = fs::metadata(&paths.runner_path).ok();
    match (native_metadata, runner_metadata) {
        (None, None) => Ok(None),
        (Some(_), None) => Ok(Some(&paths.native_path)),
        (None, Some(_)) => Ok(Some(&paths.runner_path)),
        (Some(_), Some(_)) => {
            if paths_match(&paths.native_path, &paths.runner_path) {
                return Ok(Some(&paths.native_path));
            }
            if file_is_byte_prefix(&paths.native_path, &paths.runner_path)? {
                return Ok(Some(&paths.runner_path));
            }
            if file_is_byte_prefix(&paths.runner_path, &paths.native_path)? {
                return Ok(Some(&paths.native_path));
            }
            Err(format!(
                "provider-native transcript conflict: native App {} and runner {} both advanced",
                paths.native_path.display(),
                paths.runner_path.display()
            ))
        }
    }
}

fn paths_match(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn first_user_title(items: &[NativeConversationItem]) -> String {
    let title = items.iter().find_map(|item| match item {
        NativeConversationItem::Message { role, text, .. } if role == "user" => Some(text.trim()),
        _ => None,
    });
    let title = title
        .filter(|value| !value.is_empty())
        .unwrap_or("Imported conversation");
    title.chars().take(120).collect()
}

fn claude_session_title(
    session: &persistence::CodeSession,
    items: &[NativeConversationItem],
) -> String {
    if session.name.trim().is_empty() {
        first_user_title(items)
    } else {
        session.name.trim().chars().take(120).collect()
    }
}

fn validate_claude_project_index(index_path: &Path, index: &Value) -> Result<(), String> {
    let object = index.as_object().ok_or_else(|| {
        format!(
            "Claude project index is not an object: {}",
            index_path.display()
        )
    })?;
    let version = object
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            format!(
                "Claude project index has no numeric schema version: {}",
                index_path.display()
            )
        })?;
    if version != CLAUDE_PROJECT_INDEX_VERSION {
        return Err(format!(
            "unsupported Claude project index schema version {version} in {}; expected {CLAUDE_PROJECT_INDEX_VERSION}",
            index_path.display()
        ));
    }
    if !object.get("entries").is_some_and(Value::is_array) {
        return Err(format!(
            "Claude project index entries are not an array: {}",
            index_path.display()
        ));
    }
    Ok(())
}

fn read_claude_project_index(index_path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(index_path) {
        Ok(raw) => {
            let index = serde_json::from_str::<Value>(&raw).map_err(|error| {
                format!(
                    "decode existing Claude project index {}: {error}",
                    index_path.display()
                )
            })?;
            validate_claude_project_index(index_path, &index)?;
            Ok(Some(index))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "read Claude project index {}: {error}",
            index_path.display()
        )),
    }
}

fn transcript_modified_metadata(path: &Path) -> Result<(i64, String), String> {
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .map_err(|error| format!("read transcript metadata {}: {error}", path.display()))?;
    let file_mtime = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("invalid transcript mtime {}: {error}", path.display()))?
        .as_millis()
        .try_into()
        .map_err(|_| format!("transcript mtime overflows i64: {}", path.display()))?;
    let modified = chrono::DateTime::<Utc>::from(modified)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok((file_mtime, modified))
}

/// Maintain Claude Code's native project catalog next to the durable JSONL.
/// The transcript remains the source of truth; this is only the provider-owned
/// discovery projection required by the native App.
fn publish_claude_project_index(
    cwd: &Path,
    native_id: &str,
    items: &[NativeConversationItem],
    git_branch: Option<&str>,
) -> Result<(), String> {
    let transcript_path = claude_native_paths(None, cwd, native_id).native_path;
    let project_dir = transcript_path.parent().ok_or_else(|| {
        format!(
            "Claude native transcript has no project directory: {}",
            transcript_path.display()
        )
    })?;
    let index_path = project_dir.join("sessions-index.json");
    fs::create_dir_all(project_dir).map_err(|error| {
        format!(
            "create Claude project index directory {}: {error}",
            project_dir.display()
        )
    })?;
    let _guard = lock_claude_project_index(&index_path)?;
    let mut index = read_claude_project_index(&index_path)?
        .unwrap_or_else(|| json!({"version": CLAUDE_PROJECT_INDEX_VERSION, "entries": []}));
    let entries = index
        .get_mut("entries")
        .and_then(Value::as_array_mut)
        .expect("validated/new Claude project index has an entries array");
    let previous = entries
        .iter()
        .find(|entry| entry["sessionId"].as_str() == Some(native_id))
        .cloned();
    entries.retain(|entry| entry["sessionId"].as_str() != Some(native_id));

    let now = Utc::now();
    let now_iso = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let created = previous
        .as_ref()
        .and_then(|entry| entry["created"].as_str())
        .unwrap_or(&now_iso)
        .to_string();
    let first_prompt = items
        .iter()
        .find_map(|item| match item {
            NativeConversationItem::Message { role, text, .. } if role == "user" => {
                Some(text.trim())
            }
            _ => None,
        })
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            previous
                .as_ref()
                .and_then(|entry| entry["firstPrompt"].as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Imported conversation".to_string());
    let projected_message_count = items
        .iter()
        .filter(|item| matches!(item, NativeConversationItem::Message { .. }))
        .count();
    let previous_message_count = previous
        .as_ref()
        .and_then(|entry| entry["messageCount"].as_u64())
        .unwrap_or_default() as usize;
    let mut entry = previous.unwrap_or_else(|| json!({}));
    let entry = entry.as_object_mut().ok_or_else(|| {
        format!(
            "Claude project index entry {native_id} is not an object: {}",
            index_path.display()
        )
    })?;
    entry.insert("sessionId".to_string(), json!(native_id));
    entry.insert("fullPath".to_string(), json!(transcript_path));
    entry.insert("fileMtime".to_string(), json!(now.timestamp_millis()));
    entry.insert("firstPrompt".to_string(), json!(first_prompt));
    entry.insert(
        "messageCount".to_string(),
        json!(projected_message_count.max(previous_message_count)),
    );
    entry.insert("created".to_string(), json!(created));
    entry.insert("modified".to_string(), json!(now_iso));
    entry.insert(
        "gitBranch".to_string(),
        json!(git_branch.unwrap_or_default()),
    );
    entry.insert("workspacePath".to_string(), json!(cwd));
    entries.push(Value::Object(entry.clone()));
    atomic_json(&index_path, &index)
}

fn remove_claude_project_index_entry(cwd: &Path, native_id: &str) -> Result<(), String> {
    let index_path = claude_native_paths(None, cwd, native_id)
        .native_path
        .parent()
        .map(|project| project.join("sessions-index.json"))
        .ok_or_else(|| "Claude native transcript has no project directory".to_string())?;
    if !index_path.parent().is_some_and(Path::is_dir) {
        return Ok(());
    }
    let _guard = lock_claude_project_index(&index_path)?;
    let Some(mut index) = read_claude_project_index(&index_path)? else {
        return Ok(());
    };
    let entries = index["entries"]
        .as_array_mut()
        .expect("validated Claude project index has an entries array");
    let previous_len = entries.len();
    entries.retain(|entry| entry["sessionId"].as_str() != Some(native_id));
    if entries.len() != previous_len {
        atomic_json(&index_path, &index)?;
    }
    Ok(())
}

/// Claude Desktop keeps a small discovery row for every Claude Code session
/// it exposes in the Code tab. The row points at the real CLI UUID; it is not
/// a transcript copy. Keep this projection beside the provider-owned JSONL
/// catalog so Desktop can discover materialized sessions without fabricating
/// another conversation history.
fn claude_desktop_sessions_root() -> PathBuf {
    let home = app_paths::native_transcript_home_dir();
    #[cfg(target_os = "windows")]
    let data_dir = home.join("AppData").join("Roaming");
    #[cfg(target_os = "macos")]
    let data_dir = home.join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let data_dir = home.join(".config");
    data_dir.join("Claude").join("claude-code-sessions")
}

fn claude_desktop_active_account_id(sessions_root: &Path) -> Option<String> {
    let config_path = sessions_root.parent()?.join("config.json");
    let config = serde_json::from_slice::<Value>(&fs::read(config_path).ok()?).ok()?;
    let account_id = config["lastKnownAccountUuid"].as_str()?;
    Uuid::parse_str(account_id).ok()?;
    Some(account_id.to_string())
}

/// Read at most `budget` directory entries. The budget counts failed and
/// non-directory entries too, so a noisy provider-owned catalog cannot turn
/// discovery into an unbounded scan. Sort the accepted prefix so its later
/// processing is deterministic.
fn bounded_directory_paths(root: &Path, budget: &mut usize) -> Vec<PathBuf> {
    if *budget == 0 {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for entry in entries {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        if let Ok(entry) = entry {
            paths.push(entry.path());
        }
    }
    paths.sort();
    paths
}

fn claude_desktop_session_path(
    sessions_root: &Path,
    cwd: &Path,
    native_id: &str,
) -> Option<PathBuf> {
    let mut account_budget = CLAUDE_DESKTOP_ACCOUNT_SCAN_LIMIT;
    let account_dirs = bounded_directory_paths(sessions_root, &mut account_budget)
        .into_iter()
        .filter(|path| path.is_dir())
        .collect::<Vec<_>>();
    let expected_filename = format!("local_{native_id}.json");

    // An existing UUID remains owned by the account that first registered it,
    // even after the user switches Claude Desktop accounts. Search every
    // account before deciding where a new discovery row should be placed.
    let mut project_budget = CLAUDE_DESKTOP_PROJECT_SCAN_LIMIT;
    let mut metadata_budget = CLAUDE_DESKTOP_METADATA_SCAN_LIMIT;
    'account_scan: for account_dir in &account_dirs {
        for project_dir in bounded_directory_paths(account_dir, &mut project_budget)
            .into_iter()
            .filter(|path| path.is_dir())
        {
            let exact_path = project_dir.join(&expected_filename);
            if exact_path.is_file() {
                let is_same_session = fs::read(&exact_path)
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                    .and_then(|value| value["cliSessionId"].as_str().map(str::to_string))
                    .as_deref()
                    == Some(native_id);
                if is_same_session {
                    return Some(exact_path);
                }
            }
            for path in bounded_directory_paths(&project_dir, &mut metadata_budget) {
                if path.extension().and_then(|value| value.to_str()) != Some("json") {
                    continue;
                }
                let Some(value) = fs::read(&path)
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                else {
                    continue;
                };
                if value["cliSessionId"].as_str() == Some(native_id) {
                    return Some(path);
                }
            }
            if metadata_budget == 0 {
                break 'account_scan;
            }
        }
        if project_budget == 0 {
            break;
        }
    }

    // A brand-new row must be registered under the currently active Desktop
    // account. Never silently place it into an arbitrary inactive account.
    let active_account_dir = sessions_root.join(claude_desktop_active_account_id(sessions_root)?);
    if !active_account_dir.is_dir() {
        return None;
    }
    let mut matching_project: Option<(i64, PathBuf)> = None;
    let mut project_budget = CLAUDE_DESKTOP_PROJECT_SCAN_LIMIT;
    let mut metadata_budget = CLAUDE_DESKTOP_METADATA_SCAN_LIMIT;
    for project_dir in bounded_directory_paths(&active_account_dir, &mut project_budget)
        .into_iter()
        .filter(|path| path.is_dir())
    {
        for path in bounded_directory_paths(&project_dir, &mut metadata_budget) {
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(value) = fs::read(&path)
                .ok()
                .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
            else {
                continue;
            };
            let matches_cwd = ["cwd", "originCwd"].into_iter().any(|field| {
                value[field]
                    .as_str()
                    .is_some_and(|value| paths_match(Path::new(value), cwd))
            });
            if !matches_cwd {
                continue;
            }
            let activity = value["lastActivityAt"]
                .as_i64()
                .or_else(|| value["createdAt"].as_i64())
                .unwrap_or_default();
            if matching_project
                .as_ref()
                .is_none_or(|(best_activity, _)| activity > *best_activity)
            {
                matching_project = Some((activity, project_dir.clone()));
            }
        }
        if metadata_budget == 0 {
            break;
        }
    }
    matching_project.map(|(_, path)| path.join(expected_filename))
}

fn assistant_turn_count(items: &[NativeConversationItem]) -> usize {
    items
        .iter()
        .filter(|item| {
            matches!(item, NativeConversationItem::Message { role, .. } if role == "assistant")
        })
        .count()
}

#[cfg(test)]
fn publish_claude_desktop_session(
    session: &persistence::CodeSession,
    cwd: &Path,
    native_id: &str,
    native_path: &Path,
    items: &[NativeConversationItem],
) -> Result<Option<PathBuf>, String> {
    if !native_path.is_file() {
        return Err(format!(
            "refusing to publish Claude Desktop metadata without transcript {}",
            native_path.display()
        ));
    }
    let sessions_root = claude_desktop_sessions_root();
    if !sessions_root.is_dir() {
        return Ok(None);
    }
    let Some(path) = claude_desktop_session_path(&sessions_root, cwd, native_id) else {
        // Account/project UUIDs belong to Desktop. A machine with no existing
        // matching project must use Claude's own import flow instead of ORG2
        // inventing identifiers that the App has never registered.
        return Ok(None);
    };
    publish_claude_desktop_session_at_path(session, cwd, native_id, native_path, items, path)
}

fn publish_claude_desktop_session_at_path(
    session: &persistence::CodeSession,
    cwd: &Path,
    native_id: &str,
    native_path: &Path,
    items: &[NativeConversationItem],
    path: PathBuf,
) -> Result<Option<PathBuf>, String> {
    let _guard = lock_claude_project_index(&path)?;
    let previous = match fs::read(&path) {
        Ok(raw) => Some(serde_json::from_slice::<Value>(&raw).map_err(|error| {
            format!(
                "decode existing Claude Desktop metadata {}: {error}",
                path.display()
            )
        })?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "read Claude Desktop metadata {}: {error}",
                path.display()
            ))
        }
    };
    let mut metadata = previous.clone().unwrap_or_else(|| json!({}));
    let object = metadata.as_object_mut().ok_or_else(|| {
        format!(
            "Claude Desktop metadata is not an object: {}",
            path.display()
        )
    })?;
    let (file_mtime, _) = transcript_modified_metadata(native_path)?;
    let title = claude_session_title(session, items);
    let is_new = previous.is_none();
    object
        .entry("sessionId".to_string())
        .or_insert_with(|| json!(format!("local_{native_id}")));
    object.insert("cliSessionId".to_string(), json!(native_id));
    object.insert("cwd".to_string(), json!(cwd));
    object
        .entry("originCwd".to_string())
        .or_insert_with(|| json!(cwd));
    object
        .entry("createdAt".to_string())
        .or_insert_with(|| json!(file_mtime));
    object
        .entry("lastFocusedAt".to_string())
        .or_insert_with(|| json!(file_mtime));
    object.insert("lastActivityAt".to_string(), json!(file_mtime));
    object.insert("title".to_string(), json!(title));
    object
        .entry("titleSource".to_string())
        .or_insert_with(|| json!("orgii"));
    object
        .entry("permissionMode".to_string())
        .or_insert_with(|| json!("default"));
    object
        .entry("isArchived".to_string())
        .or_insert_with(|| json!(false));
    object
        .entry("remoteMcpServersConfig".to_string())
        .or_insert_with(|| json!([]));
    object.insert(
        "completedTurns".to_string(),
        json!(assistant_turn_count(items)),
    );
    object
        .entry("alwaysAllowedReasons".to_string())
        .or_insert_with(|| json!([]));
    object
        .entry("sessionPermissionUpdates".to_string())
        .or_insert_with(|| json!([]));
    object
        .entry("classifierSummaryEnabled".to_string())
        .or_insert_with(|| json!(true));
    if let Some(model) = session
        .model
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        object.insert("model".to_string(), json!(model));
    }
    if is_new {
        object.insert("orgiiMaterialization".to_string(), json!(true));
    }
    atomic_json(&path, &metadata)?;
    let published: Value = serde_json::from_slice(
        &fs::read(&path).map_err(|error| format!("read back Claude Desktop metadata: {error}"))?,
    )
    .map_err(|error| format!("decode published Claude Desktop metadata: {error}"))?;
    if published["cliSessionId"].as_str() != Some(native_id)
        || published["sessionId"].as_str().is_none()
        || !published["completedTurns"].is_number()
        || !["cwd", "originCwd"].into_iter().any(|field| {
            published[field]
                .as_str()
                .is_some_and(|value| paths_match(Path::new(value), cwd))
        })
    {
        return Err(format!(
            "Claude Desktop metadata read-back rejected {}",
            path.display()
        ));
    }
    Ok(Some(path))
}

fn remove_orgii_claude_desktop_session(cwd: &Path, native_id: &str) -> Result<(), String> {
    let sessions_root = claude_desktop_sessions_root();
    let Some(path) = claude_desktop_session_path(&sessions_root, cwd, native_id) else {
        return Ok(());
    };
    let _guard = lock_claude_project_index(&path)?;
    let metadata = fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok());
    if metadata.as_ref().is_some_and(|value| {
        value["cliSessionId"].as_str() == Some(native_id)
            && value["orgiiMaterialization"].as_bool() == Some(true)
    }) {
        remove_file_if_present(&path)?;
    }
    Ok(())
}

/// Refresh the native Claude App catalog from metadata written by the actual
/// Claude process in its isolated account profile. This path reads two small
/// index files and transcript stat metadata only; it never reparses a large
/// JSONL. Unknown provider fields are retained so ORG2 does not downgrade a
/// newer-but-still-v1 entry shape.
fn refresh_claude_project_index_from_provider(
    cwd: &Path,
    native_id: &str,
    native_path: &Path,
    runner_path: &Path,
    git_branch: Option<&str>,
) -> Result<bool, String> {
    let native_index_path = native_path
        .parent()
        .ok_or_else(|| {
            format!(
                "Claude native transcript has no project directory: {}",
                native_path.display()
            )
        })?
        .join("sessions-index.json");
    let runner_index_path = runner_path
        .parent()
        .ok_or_else(|| {
            format!(
                "Claude runner transcript has no project directory: {}",
                runner_path.display()
            )
        })?
        .join("sessions-index.json");

    let Some(provider_index) = read_claude_project_index(&runner_index_path)? else {
        return Ok(false);
    };
    let Some(provider_entry) = provider_index["entries"]
        .as_array()
        .expect("validated Claude provider index has an entries array")
        .iter()
        .find(|entry| entry["sessionId"].as_str() == Some(native_id))
        .cloned()
    else {
        return Ok(false);
    };
    let provider_entry = provider_entry.as_object().ok_or_else(|| {
        format!(
            "Claude provider index entry {native_id} is not an object: {}",
            runner_index_path.display()
        )
    })?;
    let (file_mtime, modified) = transcript_modified_metadata(native_path)?;
    let provider_mtime = provider_entry
        .get("fileMtime")
        .and_then(Value::as_i64)
        .ok_or_else(|| {
            format!(
                "Claude provider index entry {native_id} has no numeric fileMtime: {}",
                runner_index_path.display()
            )
        })?;
    if provider_mtime < file_mtime {
        // The provider index snapshot predates the durable transcript. Its
        // messageCount may therefore be stale; let the deferred fallback parse
        // derive a correct projection instead of publishing a false count.
        return Ok(false);
    }
    if !provider_entry
        .get("messageCount")
        .is_some_and(Value::is_u64)
    {
        return Err(format!(
            "Claude provider index entry {native_id} has no numeric messageCount: {}",
            runner_index_path.display()
        ));
    }

    fs::create_dir_all(
        native_index_path
            .parent()
            .expect("Claude native project index has a parent"),
    )
    .map_err(|error| {
        format!(
            "create Claude native project index directory {}: {error}",
            native_index_path.display()
        )
    })?;
    let _guard = lock_claude_project_index(&native_index_path)?;
    let mut native_index = read_claude_project_index(&native_index_path)?
        .unwrap_or_else(|| json!({"version": CLAUDE_PROJECT_INDEX_VERSION, "entries": []}));
    let entries = native_index["entries"]
        .as_array_mut()
        .expect("validated/new Claude native index has an entries array");
    let previous = entries
        .iter()
        .find(|entry| entry["sessionId"].as_str() == Some(native_id))
        .cloned();
    entries.retain(|entry| entry["sessionId"].as_str() != Some(native_id));

    let mut merged = previous
        .and_then(|entry| entry.as_object().cloned())
        .unwrap_or_default();
    merged.extend(provider_entry.clone());
    merged.insert("sessionId".to_string(), json!(native_id));
    merged.insert("fullPath".to_string(), json!(native_path));
    merged.insert("fileMtime".to_string(), json!(file_mtime));
    merged.insert("modified".to_string(), json!(modified));
    merged.insert("workspacePath".to_string(), json!(cwd));
    if merged
        .get("gitBranch")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        merged.insert(
            "gitBranch".to_string(),
            json!(git_branch.unwrap_or_default()),
        );
    }
    entries.push(Value::Object(merged));
    atomic_json(&native_index_path, &native_index)?;
    Ok(true)
}

fn claude_records(
    native_id: &str,
    cwd: &Path,
    items: &[NativeConversationItem],
) -> Result<Vec<Value>, String> {
    let mut records = Vec::with_capacity(items.len().saturating_mul(2));
    let mut parent_uuid: Option<String> = None;
    for item in items {
        if let NativeConversationItem::ContextSummary {
            id,
            summary,
            created_at,
        } = item
        {
            let boundary_uuid = stable_uuid("orgii-claude-compact-boundary", native_id, id);
            records.push(json!({
                "type": "system",
                "subtype": "compact_boundary",
                "uuid": boundary_uuid,
                "parentUuid": parent_uuid,
                "sessionId": native_id,
                "cwd": cwd,
                "timestamp": created_at,
                "compactMetadata": {"trigger": "import"}
            }));
            let summary_uuid = stable_uuid("orgii-claude-compact-summary", native_id, id);
            records.push(json!({
                "type": "user",
                "uuid": summary_uuid,
                "parentUuid": boundary_uuid,
                "isCompactSummary": true,
                "isSidechain": false,
                "userType": "external",
                "sessionId": native_id,
                "cwd": cwd,
                "timestamp": created_at,
                "message": {"role": "user", "content": summary},
                "entrypoint": "orgii"
            }));
            parent_uuid = Some(summary_uuid);
            continue;
        }
        let record_uuid = stable_uuid("orgii-claude-native", native_id, item.id());
        let (record_type, message, extra) = match item {
            NativeConversationItem::Message {
                role, text, images, ..
            } => {
                let content = if role == "assistant" {
                    Value::Array(vec![json!({"type": "text", "text": text})])
                } else if images.is_empty() {
                    Value::String(text.clone())
                } else {
                    let mut blocks = vec![json!({"type": "text", "text": text})];
                    for image in images {
                        blocks.push(image_block(image)?);
                    }
                    Value::Array(blocks)
                };
                (
                    role.clone(),
                    json!({"role": role, "content": content}),
                    None,
                )
            }
            NativeConversationItem::ToolCall {
                call_id,
                name,
                arguments,
                ..
            } => (
                "assistant".to_string(),
                json!({
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": call_id,
                        "name": name,
                        "input": serde_json::from_str::<Value>(arguments)
                            .map_err(|err| format!("parse tool arguments: {err}"))?
                    }]
                }),
                None,
            ),
            NativeConversationItem::ToolResult {
                call_id,
                output,
                is_error,
                interrupted,
                ..
            } => (
                "user".to_string(),
                json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": call_id,
                        "content": output,
                        "is_error": *is_error || *interrupted
                    }]
                }),
                Some(json!({"toolUseResult": output})),
            ),
            NativeConversationItem::ContextSummary { .. } => {
                unreachable!("context summaries are emitted before ordinary Claude records")
            }
        };
        let mut record = json!({
            "type": record_type,
            "uuid": record_uuid,
            "parentUuid": parent_uuid,
            "isSidechain": false,
            "userType": "external",
            "sessionId": native_id,
            "cwd": cwd,
            "timestamp": item.created_at(),
            "message": message,
            "entrypoint": "orgii"
        });
        if let Some(Value::Object(extra)) = extra {
            record.as_object_mut().expect("record object").extend(extra);
        }
        parent_uuid = Some(record_uuid);
        records.push(record);
    }
    Ok(records)
}

fn claude_resume_checkpoint(
    native_id: &str,
    leaf_uuid: &str,
    items: &[NativeConversationItem],
) -> Value {
    let last_prompt = items
        .iter()
        .rev()
        .find_map(|item| match item {
            NativeConversationItem::Message { role, text, .. }
                if role == "user" && !text.trim().is_empty() =>
            {
                Some(text.as_str())
            }
            _ => None,
        })
        .unwrap_or_default();
    json!({
        "type": "last-prompt",
        "lastPrompt": last_prompt,
        "leafUuid": leaf_uuid,
        "sessionId": native_id,
    })
}

fn claude_custom_title(native_id: &str, title: &str) -> Value {
    json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": native_id,
    })
}

fn claude_materialization_records(
    native_id: &str,
    cwd: &Path,
    items: &[NativeConversationItem],
    title: &str,
) -> Result<Vec<Value>, String> {
    let mut records = claude_records_with_resume_checkpoint(native_id, cwd, items)?;
    records.insert(0, claude_custom_title(native_id, title));
    Ok(records)
}

fn claude_records_with_resume_checkpoint(
    native_id: &str,
    cwd: &Path,
    items: &[NativeConversationItem],
) -> Result<Vec<Value>, String> {
    let mut records = claude_records(native_id, cwd, items)?;
    if let Some(leaf_uuid) = records
        .last()
        .and_then(|record| record["uuid"].as_str())
        .map(str::to_string)
    {
        records.push(claude_resume_checkpoint(native_id, &leaf_uuid, items));
    }
    Ok(records)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NativeSuffixApplication {
    Missing,
    AlreadyApplied,
}

fn inspect_claude_suffix_application(
    path: &Path,
    expected_records: &[Value],
) -> Result<(NativeSuffixApplication, Option<String>), String> {
    let mut expected_records_by_id = HashMap::with_capacity(expected_records.len());
    for record in expected_records {
        let id = record["uuid"]
            .as_str()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                "projected Claude native suffix record has no stable uuid".to_string()
            })?;
        let mut normalized = record.clone();
        normalized
            .as_object_mut()
            .ok_or_else(|| "projected Claude native suffix record is not an object".to_string())?
            .remove("parentUuid");
        if expected_records_by_id
            .insert(id.to_string(), normalized)
            .is_some()
        {
            return Err(format!(
                "projected Claude native suffix contains duplicate uuid {id}"
            ));
        }
    }
    if expected_records_by_id.is_empty() {
        return Err("projected Claude native suffix is empty".to_string());
    }
    let file = fs::File::open(path)
        .map_err(|error| format!("open Claude native transcript {}: {error}", path.display()))?;
    let mut found_ids = HashSet::with_capacity(expected_records_by_id.len());
    let mut active_leaf_uuid = None;
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| {
            format!(
                "read Claude native transcript {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<Value>(&line).map_err(|error| {
            format!(
                "decode Claude native transcript {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        if record["type"] == "last-prompt" {
            if let Some(leaf_uuid) = record["leafUuid"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            {
                active_leaf_uuid = Some(leaf_uuid.to_string());
            }
        } else if let Some(uuid) = record["uuid"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        {
            active_leaf_uuid = Some(uuid.to_string());
            if let Some(expected) = expected_records_by_id.get(uuid) {
                let mut normalized = record.clone();
                normalized
                    .as_object_mut()
                    .ok_or_else(|| {
                        format!(
                            "Claude native transcript {} contains non-object stable suffix record {uuid}",
                            path.display()
                        )
                    })?
                    .remove("parentUuid");
                if &normalized != expected {
                    return Err(format!(
                        "Claude native transcript {} contains stable suffix uuid {uuid} with conflicting content",
                        path.display()
                    ));
                }
                if !found_ids.insert(uuid.to_string()) {
                    return Err(format!(
                        "Claude native transcript {} contains duplicate stable suffix uuid {uuid}",
                        path.display()
                    ));
                }
            }
        }
    }

    if found_ids.is_empty() {
        Ok((NativeSuffixApplication::Missing, active_leaf_uuid))
    } else if found_ids.len() == expected_records_by_id.len() {
        Ok((NativeSuffixApplication::AlreadyApplied, active_leaf_uuid))
    } else {
        Err(format!(
            "Claude native transcript {} contains {} of {} stable suffix records; refusing a mixed retry",
            path.display(),
            found_ids.len(),
            expected_records_by_id.len()
        ))
    }
}

fn ensure_claude_native_metadata(
    path: &Path,
    native_id: &str,
    complete_items: &[NativeConversationItem],
    title: &str,
) -> Result<(), String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("open Claude native transcript {}: {error}", path.display()))?;
    let mut last_message_uuid: Option<String> = None;
    let mut last_message_is_orgii = false;
    let mut last_checkpoint_leaf: Option<String> = None;
    let mut has_custom_title = false;
    let mut has_orgii_record = false;
    for (line_index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| {
            format!(
                "read Claude native transcript {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record = serde_json::from_str::<Value>(&line).map_err(|error| {
            format!(
                "decode Claude native transcript {} line {}: {error}",
                path.display(),
                line_index + 1
            )
        })?;
        has_custom_title |= record["type"] == "custom-title"
            && record["customTitle"]
                .as_str()
                .is_some_and(|value| !value.trim().is_empty());
        has_orgii_record |= record["entrypoint"].as_str() == Some("orgii");
        if record["type"] == "last-prompt" {
            last_checkpoint_leaf = record["leafUuid"].as_str().map(str::to_string);
        } else if let Some(uuid) = record["uuid"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        {
            last_message_uuid = Some(uuid.to_string());
            last_message_is_orgii = record["entrypoint"].as_str() == Some("orgii");
        }
    }
    let mut metadata = Vec::with_capacity(2);
    if has_orgii_record && !has_custom_title && !title.trim().is_empty() {
        metadata.push(claude_custom_title(native_id, title));
    }
    if let Some(leaf_uuid) = last_message_uuid.filter(|_| last_message_is_orgii) {
        if last_checkpoint_leaf.as_deref() != Some(leaf_uuid.as_str()) {
            metadata.push(claude_resume_checkpoint(
                native_id,
                &leaf_uuid,
                complete_items,
            ));
        }
    }
    if metadata.is_empty() {
        return Ok(());
    }
    append_suffix_atomically(path, &serialize_jsonl(&metadata)?)
}

/// Codex exit codes for a tool output ORG2 injects. A `function_call_output`
/// carries text, so the only failure channel the Codex rollout has is the
/// exec envelope its own shell tools emit. Writing the bare output instead
/// tells the resumed model a killed or failed command succeeded.
const CODEX_TOOL_FAILURE_EXIT_CODE: i64 = 1;
const CODEX_TOOL_INTERRUPT_EXIT_CODE: i64 = 130;

fn codex_function_call_output(output: &str, is_error: bool, interrupted: bool) -> Value {
    if !is_error && !interrupted {
        return Value::String(output.to_string());
    }
    let exit_code = if interrupted {
        CODEX_TOOL_INTERRUPT_EXIT_CODE
    } else {
        CODEX_TOOL_FAILURE_EXIT_CODE
    };
    Value::String(json!({"exit_code": exit_code, "output": output}).to_string())
}

fn codex_response_items(items: &[NativeConversationItem]) -> Vec<Value> {
    let mut projected = Vec::with_capacity(items.len());
    for item in items {
        match item {
            NativeConversationItem::Message {
                id,
                role,
                text,
                images,
                ..
            } => {
                let text_type = if role == "user" {
                    "input_text"
                } else {
                    "output_text"
                };
                let mut content = vec![json!({"type": text_type, "text": text})];
                if role == "user" {
                    content.extend(
                        images
                            .iter()
                            .map(|image| json!({"type": "input_image", "image_url": image})),
                    );
                }
                // `id` is part of Codex's native response-item schema and is
                // preserved by `thread/inject_items`. Unlike Codex's
                // user-role system/context prefix rows, an injected canonical
                // user message therefore has a stable native item id without
                // needing ORG2-only metadata inside the provider transcript.
                projected
                    .push(json!({"type": "message", "id": id, "role": role, "content": content}));
            }
            NativeConversationItem::ToolCall {
                id,
                call_id,
                name,
                arguments,
                ..
            } => projected.push(json!({
                "type": "function_call",
                "id": id,
                "name": name,
                "arguments": arguments,
                "call_id": call_id
            })),
            NativeConversationItem::ToolResult {
                call_id,
                output,
                is_error,
                interrupted,
                ..
            } => projected.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": codex_function_call_output(output, *is_error, *interrupted)
            })),
            NativeConversationItem::ContextSummary { id, summary, .. } => projected.push(json!({
                "type": "message",
                "id": id,
                "role": "user",
                "content": [{"type": "input_text", "text": summary}]
            })),
        }
    }
    projected
}

fn provider_canonical_cwd(cwd: PathBuf) -> PathBuf {
    fs::canonicalize(&cwd).unwrap_or(cwd)
}

fn execution_cwd(session: &persistence::CodeSession) -> Result<PathBuf, String> {
    // Keep this selection identical to the CLI runner. A removed session
    // worktree is no longer an executable workspace: the runner falls back
    // to repo_path, and Claude keys its native store by that effective cwd.
    // Materializing under the stale worktree key would therefore publish a
    // valid UUID that `claude --resume` cannot find from the runner's cwd.
    let value = session
        .worktree_path
        .as_deref()
        .filter(|value| !value.trim().is_empty() && Path::new(value).is_dir())
        .or_else(|| {
            session
                .repo_path
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        });
    let cwd = match value {
        Some(value) => PathBuf::from(value),
        None => std::env::current_dir().map_err(|err| format!("resolve execution cwd: {err}"))?,
    };

    // Provider CLIs identify projects by the canonical working directory.
    // This matters on macOS where `/tmp` is a symlink to `/private/tmp`:
    // writing a Claude transcript below `projects/-tmp-...` looks correct to
    // our reader, but `claude --resume` searches `projects/-private-tmp-...`
    // and rejects the freshly materialized UUID.  Use the same identity the
    // child process observes, while retaining the configured path for a
    // not-yet-created repository so materialization still fails/rolls back at
    // the normal launch boundary.
    Ok(provider_canonical_cwd(cwd))
}

fn find_codex_materialization(root: &Path, native_id: &str) -> Result<Option<PathBuf>, String> {
    let suffix = format!("-{native_id}.jsonl");
    let mut pending = vec![root.to_path_buf()];
    let mut visited = 0usize;
    while let Some(directory) = pending.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && directory == root => {
                return Ok(None)
            }
            Err(error) => {
                return Err(format!(
                    "scan Codex transcript directory {}: {error}",
                    directory.display()
                ))
            }
        };
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "read Codex transcript directory entry {}: {error}",
                    directory.display()
                )
            })?;
            visited += 1;
            if visited > MAX_ITEMS {
                return Err(format!(
                    "Codex transcript scan under {} exceeded {MAX_ITEMS} entries",
                    root.display()
                ));
            }
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| {
                format!("inspect Codex transcript path {}: {error}", path.display())
            })?;
            if file_type.is_dir() {
                pending.push(path);
            } else if file_type.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.ends_with(&suffix))
            {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

fn discard_cli_materialization(session_id: &str, native_id: &str) -> Result<bool, String> {
    let session = persistence::get_session(session_id)
        .map_err(|err| format!("load CLI session {session_id}: {err}"))?
        .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let bound = persistence::get_cli_session_id_for_account(session_id, account_id)
        .map_err(|err| format!("read native binding for {session_id}: {err}"))?;
    if bound.as_deref() != Some(native_id) {
        return Err(
            "refusing to remove a native transcript that is not the episode's current binding"
                .to_string(),
        );
    }
    let agent = session.cli_agent_type.as_deref().unwrap_or_default();
    let cwd = execution_cwd(&session)?;
    let paths = match agent {
        "claude_code" => existing_claude_native_paths(account_id, &cwd, native_id)
            .unwrap_or_else(|| claude_native_paths(account_id, &cwd, native_id)),
        "codex" => {
            let account_id = account_id
                .ok_or_else(|| "native Codex materialization has no account binding".to_string())?;
            let Some(paths) = existing_codex_native_paths(account_id, native_id)? else {
                // A previous rollback may have removed the rollout and then
                // failed while clearing the DB binding. Treat the missing
                // marked artifact as already removed so retry can finish the
                // durable state transition instead of wedging the episode.
                persistence::clear_cli_resume_state(session_id, "native_materialization_rollback")
                    .map_err(|err| format!("clear native materialization binding: {err}"))?;
                return Ok(false);
            };
            paths
        }
        _ => return Ok(false),
    };
    let removed = match agent {
        "codex" => {
            if paths.native_path.is_file() {
                codex_native_catalog::archive_thread(
                    &codex_native_app_home(),
                    &paths.native_path,
                    native_id,
                    &cwd,
                )?;
            }
            let runner_removed = remove_file_if_present(&paths.runner_path)?;
            let native_removed = remove_file_if_present(&paths.native_path)?;
            runner_removed || native_removed
        }
        "claude_code" => {
            let _transcript_guard = lock_claude_transcript(&paths.native_path)?;
            // Remove ORG2's discovery projection before the transcript so a
            // partial rollback cannot leave a visible Desktop row whose CLI
            // UUID no longer exists on disk.
            remove_orgii_claude_desktop_session(&cwd, native_id)?;
            let runner_removed = remove_file_if_present(&paths.runner_path)?;
            let native_removed = remove_file_if_present(&paths.native_path)?;
            remove_claude_project_index_entry(&cwd, native_id)?;
            runner_removed || native_removed
        }
        _ => false,
    };
    persistence::clear_staged_cli_session_id_for_account(session_id, account_id, native_id)
        .map_err(|err| format!("clear native materialization binding: {err}"))?;
    Ok(removed)
}

fn materialize_cli(
    session_id: &str,
    items: &[NativeConversationItem],
) -> Result<NativeMaterializationReceipt, String> {
    let session = persistence::get_session(session_id)
        .map_err(|err| format!("load CLI session {session_id}: {err}"))?
        .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
    if session.transcript_source != TRANSCRIPT_SOURCE_NATIVE {
        return Err(format!(
            "CLI target {:?} has no native transcript reader/writer contract",
            session.cli_agent_type
        ));
    }
    if session.cli_session_id.is_some() {
        return Err("native materialization requires a fresh empty execution episode".to_string());
    }
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let cwd = execution_cwd(&session)?;
    let agent = session.cli_agent_type.as_deref().unwrap_or_default();
    let (native_id, paths) = match agent {
        "claude_code" => {
            let native_id = Uuid::new_v4().to_string();
            let paths = claude_native_paths(account_id, &cwd, &native_id);
            let title = claude_session_title(&session, items);
            let bound =
                persistence::stage_cli_session_id_for_account(session_id, account_id, &native_id)
                    .map_err(|err| format!("record pending Claude materialization: {err}"))?;
            if !bound {
                return Err(format!(
                    "record pending Claude materialization: target session {session_id} disappeared"
                ));
            }
            let _transcript_guard = lock_claude_transcript(&paths.native_path)?;
            if let Err(error) = write_native_store_jsonl(
                &paths,
                &claude_materialization_records(&native_id, &cwd, items, &title)?,
            ) {
                let _ = remove_file_if_present(&paths.runner_path);
                let _ = remove_file_if_present(&paths.native_path);
                let _ = persistence::clear_staged_cli_session_id_for_account(
                    session_id, account_id, &native_id,
                );
                return Err(error);
            }
            (native_id, paths)
        }
        "codex" => {
            let account_id = account_id.ok_or_else(|| {
                "native Codex materialization requires an explicit local account".to_string()
            })?;
            let title = if session.name.trim().is_empty() {
                first_user_title(items)
            } else {
                session.name.clone()
            };
            let codex_home = codex_native_app_home();
            let registered = codex_native_catalog::register_thread(
                &codex_home,
                &cwd,
                &title,
                &codex_response_items(items),
            )?;
            let staged = persistence::stage_cli_session_id_for_account(
                session_id,
                Some(account_id),
                &registered.id,
            )
            .map_err(|err| format!("record pending Codex materialization: {err}"))?;
            if !staged {
                let _ = codex_native_catalog::archive_thread(
                    &codex_home,
                    &registered.path,
                    &registered.id,
                    &cwd,
                );
                let _ = remove_file_if_present(&registered.path);
                return Err(format!(
                    "record pending Codex materialization: target session {session_id} disappeared"
                ));
            }
            let paths = match registered_codex_native_paths(account_id, &registered.path) {
                Ok(paths) => paths,
                Err(error) => {
                    let _ = codex_native_catalog::archive_thread(
                        &codex_home,
                        &registered.path,
                        &registered.id,
                        &cwd,
                    );
                    let _ = remove_file_if_present(&registered.path);
                    let _ = persistence::clear_staged_cli_session_id_for_account(
                        session_id,
                        Some(account_id),
                        &registered.id,
                    );
                    return Err(error);
                }
            };
            cache_codex_native_paths(account_id, &registered.id, &paths);
            if let Err(error) = replace_runner_link(&paths.native_path, &paths.runner_path) {
                let _ = codex_native_catalog::archive_thread(
                    &codex_home,
                    &paths.native_path,
                    &registered.id,
                    &cwd,
                );
                let _ = remove_file_if_present(&paths.runner_path);
                let _ = remove_file_if_present(&paths.native_path);
                let _ = persistence::clear_staged_cli_session_id_for_account(
                    session_id,
                    Some(account_id),
                    &registered.id,
                );
                return Err(error);
            }
            (registered.id, paths)
        }
        other => {
            return Err(format!(
                "CLI target {other:?} cannot write a provider-native role/tool transcript"
            ))
        }
    };
    if agent == "claude_code" {
        if let Err(error) =
            publish_claude_project_index(&cwd, &native_id, items, session.branch.as_deref())
        {
            let _ = remove_file_if_present(&paths.runner_path);
            let _ = remove_file_if_present(&paths.native_path);
            let _ = remove_claude_project_index_entry(&cwd, &native_id);
            let _ = persistence::clear_staged_cli_session_id_for_account(
                session_id, account_id, &native_id,
            );
            return Err(error);
        }
    }
    let published =
        persistence::update_cli_session_id_for_account(session_id, account_id, &native_id)
            .map_err(|error| format!("publish native materialization binding: {error}"))?;
    if !published {
        return Err(format!(
            "publish native materialization binding: target session {session_id} disappeared"
        ));
    }
    tracing::info!(
        session_id,
        native_session_id = native_id,
        target = agent,
        native_path = %paths.native_path.display(),
        runner_path = %paths.runner_path.display(),
        item_count = items.len(),
        "materialized provider-native conversation transcript"
    );
    Ok(NativeMaterializationReceipt {
        native_session_id: native_id,
        item_count: items.len(),
    })
}

fn materialize_native_agent(
    session_id: &str,
    items: &[NativeConversationItem],
) -> Result<NativeMaterializationReceipt, String> {
    agent_core::session::persistence::get_session(session_id)
        .map_err(|err| format!("load native Agent session {session_id}: {err}"))?
        .ok_or_else(|| format!("native Agent session {session_id} does not exist"))?;
    let receipt = agent_core::session::persistence::seed_session_with_materialized_history(
        session_id,
        &native_agent_seeds(session_id, items),
    )
    .map_err(|err| format!("seed native Agent transcript {session_id}: {err}"))?;
    if receipt.row_count != items.len() {
        return Err(format!(
            "native Agent seed persisted {} of {} canonical items",
            receipt.row_count,
            items.len()
        ));
    }
    Ok(NativeMaterializationReceipt {
        native_session_id: session_id.to_string(),
        item_count: items.len(),
    })
}

fn synchronize_cli(
    session_id: &str,
    complete_items: &[NativeConversationItem],
    append_items: &[NativeConversationItem],
) -> Result<NativeMaterializationReceipt, String> {
    let session = persistence::get_session(session_id)
        .map_err(|err| format!("load CLI session {session_id}: {err}"))?
        .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
    if session.transcript_source != TRANSCRIPT_SOURCE_NATIVE {
        return Err(format!(
            "CLI target {:?} has no native transcript reader/writer contract",
            session.cli_agent_type
        ));
    }
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let native_id = persistence::get_cli_session_id_for_account(session_id, account_id)
        .map_err(|err| format!("read native binding for {session_id}: {err}"))?
        .ok_or_else(|| format!("CLI session {session_id} has no native resume binding"))?;
    let cwd = execution_cwd(&session)?;
    let agent = session.cli_agent_type.as_deref().unwrap_or_default();
    let paths = match agent {
        "claude_code" => existing_claude_native_paths(account_id, &cwd, &native_id)
            .unwrap_or_else(|| claude_native_paths(account_id, &cwd, &native_id)),
        "codex" => {
            let account_id = account_id
                .ok_or_else(|| "native Codex synchronization has no account binding".to_string())?;
            existing_codex_native_paths(account_id, &native_id)?
                .ok_or_else(|| format!("materialized Codex transcript {native_id} was not found"))?
        }
        other => {
            return Err(format!(
                "CLI target {other:?} cannot write a provider-native role/tool transcript"
            ))
        }
    };
    // A provider UUID is append-only after its first materialization. Claude
    // Rust has already proved the exact provider transcript is a semantic
    // prefix. Append only the verified suffix so provider-private state such
    // as usage and native compact checkpoints remains untouched.
    match agent {
        "claude_code" => {
            // Inspection and suffix commit are one cross-process transaction.
            // Lock the stable adjacent lock file, not the replaceable JSONL
            // inode, so another ORG2 process cannot race this mutation.
            let _transcript_guard = lock_claude_transcript(&paths.native_path)?;
            ensure_durable_runner_alias(&paths, &native_id)?;
            if !append_items.is_empty() {
                let mut records = claude_records(&native_id, &cwd, append_items)?;
                let (suffix_application, parent_uuid) =
                    inspect_claude_suffix_application(&paths.native_path, &records)?;
                let appended = suffix_application == NativeSuffixApplication::Missing;
                if appended {
                    if let Some(first) = records.first_mut() {
                        first["parentUuid"] = parent_uuid.map(Value::String).unwrap_or(Value::Null);
                    }
                    if let Some(leaf_uuid) = records
                        .last()
                        .and_then(|record| record["uuid"].as_str())
                        .map(str::to_string)
                    {
                        records.push(claude_resume_checkpoint(
                            &native_id,
                            &leaf_uuid,
                            complete_items,
                        ));
                    }
                    let payload = serialize_jsonl(&records)?;
                    append_suffix_atomically(&paths.native_path, &payload)?;
                }
            }
            let title = claude_session_title(&session, complete_items);
            ensure_claude_native_metadata(&paths.native_path, &native_id, complete_items, &title)?;
            publish_claude_project_index(
                &cwd,
                &native_id,
                complete_items,
                session.branch.as_deref(),
            )?;
        }
        "codex" => {
            let promoted_to_native_app = ensure_durable_runner_alias(&paths, &native_id)?;
            let title = if session.name.trim().is_empty() {
                first_user_title(complete_items)
            } else {
                session.name.clone()
            };
            if promoted_to_native_app || !append_items.is_empty() {
                codex_native_catalog::synchronize_thread(
                    &codex_native_app_home(),
                    &paths.native_path,
                    &native_id,
                    &cwd,
                    &title,
                    &codex_response_items(append_items),
                )?;
            }
        }
        _ => unreachable!("unsupported targets returned above"),
    }
    let published =
        persistence::update_cli_session_id_for_account(session_id, account_id, &native_id)
            .map_err(|error| format!("publish synchronized native binding: {error}"))?;
    if !published {
        return Err(format!(
            "publish synchronized native binding: target session {session_id} disappeared"
        ));
    }
    Ok(NativeMaterializationReceipt {
        native_session_id: native_id,
        item_count: complete_items.len(),
    })
}

#[derive(Debug)]
enum BoundNativeCatalogRefresh {
    Claude {
        receipt: persistence::NativeCatalogRefreshReceipt,
        session_id: String,
        cwd: PathBuf,
        native_id: String,
        native_path: PathBuf,
        runner_path: PathBuf,
        branch: Option<String>,
    },
    Codex {
        receipt: persistence::NativeCatalogRefreshReceipt,
        cwd: PathBuf,
        native_id: String,
        native_path: PathBuf,
        title: String,
    },
}

/// Converge the provider-written transcript back to the native application's
/// durable file after a CLI turn exits. The provider may replace the isolated
/// profile symlink with a regular file, so this copy/relink step remains inside
/// the provider-identity boundary. Catalog/index refresh is deliberately
/// returned as deferred work: it must not hold that boundary or block the next
/// turn.
fn converge_bound_native_transcript(
    session_id: &str,
) -> Result<Option<BoundNativeCatalogRefresh>, String> {
    let session = persistence::get_session(session_id)
        .map_err(|error| format!("load CLI session {session_id}: {error}"))?
        .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
    if session.transcript_source != TRANSCRIPT_SOURCE_NATIVE {
        return Ok(None);
    }
    let account_id = session
        .account_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let Some(native_id) = persistence::get_cli_session_id_for_account(session_id, account_id)
        .map_err(|error| format!("read native binding for {session_id}: {error}"))?
    else {
        return Ok(None);
    };
    let agent = session.cli_agent_type.clone().unwrap_or_default();
    if !matches!(agent.as_str(), "claude_code" | "codex") {
        return Ok(None);
    }

    let cwd = execution_cwd(&session)?;
    // Convergence runs for every native-transcript session that carries a
    // provider binding, not only the ones ORG2 materialized. A binding whose
    // provider store this host cannot address at all — an ambient-auth Codex
    // session with no local account, or a rollout that lives outside the
    // scanned roots — is missing evidence, not proof of divergence, so it
    // must not fail the turn closed.
    let paths = match agent.as_str() {
        "claude_code" => match existing_claude_native_paths(account_id, &cwd, &native_id) {
            Some(paths) => paths,
            None => {
                tracing::warn!(
                    session_id,
                    native_id,
                    "skipping native transcript convergence: no Claude transcript on this host"
                );
                return Ok(None);
            }
        },
        "codex" => {
            let Some(account_id) = account_id else {
                tracing::warn!(
                    session_id,
                    native_id,
                    "skipping native transcript convergence: Codex session has no local account"
                );
                return Ok(None);
            };
            match existing_codex_native_paths(account_id, &native_id)? {
                Some(paths) => paths,
                None => {
                    tracing::warn!(
                        session_id,
                        native_id,
                        "skipping native transcript convergence: no Codex rollout on this host"
                    );
                    return Ok(None);
                }
            }
        }
        _ => unreachable!("provider checked before acquiring publication owner"),
    };
    // Claude may replace the isolated alias with a regular file while it
    // exits. Converging that file is a provider-store mutation and therefore
    // shares the same cross-process UUID lock as fresh/suffix/discard.
    let _claude_transcript_guard = if agent == "claude_code" {
        Some(lock_claude_transcript(&paths.native_path)?)
    } else {
        None
    };
    // Persist intent before the transcript alias mutation. A crash after this
    // point can therefore leave, at worst, a dirty receipt that startup will
    // retry; it cannot silently lose a required native-App catalog refresh.
    let receipt = persistence::request_native_catalog_refresh(session_id, account_id, &native_id)
        .map_err(|error| format!("request native App catalog refresh: {error}"))?
        .ok_or_else(|| {
            format!(
                "request native App catalog refresh: binding {native_id} for {session_id} changed"
            )
        })?;
    let promoted = ensure_durable_runner_alias(&paths, &native_id)?;
    if !promoted && agent == "codex" {
        // The provider wrote through the existing native-App alias. Initial
        // Codex's supported app-server registration already owns its catalog.
        persistence::acknowledge_native_catalog_refresh(&receipt)
            .map_err(|error| format!("acknowledge native App catalog refresh: {error}"))?;
        return Ok(None);
    }
    Ok(Some(match agent.as_str() {
        "claude_code" => BoundNativeCatalogRefresh::Claude {
            receipt,
            session_id: session_id.to_string(),
            cwd,
            native_id,
            native_path: paths.native_path,
            runner_path: paths.runner_path,
            branch: session.branch,
        },
        "codex" => BoundNativeCatalogRefresh::Codex {
            receipt,
            cwd,
            native_id,
            native_path: paths.native_path,
            title: if session.name.trim().is_empty() {
                "Imported conversation".to_string()
            } else {
                session.name
            },
        },
        _ => unreachable!("provider checked before acquiring publication owner"),
    }))
}

fn refresh_bound_native_catalog(refresh: BoundNativeCatalogRefresh) -> Result<(), String> {
    let receipt = match refresh {
        BoundNativeCatalogRefresh::Claude {
            receipt,
            session_id,
            cwd,
            native_id,
            native_path,
            runner_path,
            branch,
        } => {
            let mut parsed_items = None;
            if !refresh_claude_project_index_from_provider(
                &cwd,
                &native_id,
                &native_path,
                &runner_path,
                branch.as_deref(),
            )? {
                // Old Claude versions and profile repairs may not publish an
                // index entry. This fallback stays outside the turn/identity
                // boundary so a large JSONL cannot delay the footer.
                let chunks = orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                    &session_id,
                    &native_path,
                )?;
                let items = native_items_from_chunks(&chunks);
                publish_claude_project_index(&cwd, &native_id, &items, branch.as_deref())?;
                parsed_items = Some(items);
            }

            // Claude Desktop does not watch Claude Code's sessions-index.json.
            // Its Code tab discovers the provider JSONL through this separate
            // metadata row. Publish it from the same deferred owner and only
            // into an existing provider-registered account/project directory.
            let desktop_root = claude_desktop_sessions_root();
            let desktop_path = desktop_root
                .is_dir()
                .then(|| claude_desktop_session_path(&desktop_root, &cwd, &native_id))
                .flatten();
            if let Some(desktop_path) = desktop_path {
                let items = match parsed_items {
                    Some(items) => items,
                    None => {
                        let chunks = orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                            &session_id,
                            &native_path,
                        )?;
                        native_items_from_chunks(&chunks)
                    }
                };
                let session = persistence::get_session(&session_id)
                    .map_err(|error| {
                        format!("load CLI session {session_id} for Claude Desktop catalog: {error}")
                    })?
                    .ok_or_else(|| {
                        format!("CLI session {session_id} disappeared before Claude Desktop catalog refresh")
                    })?;
                publish_claude_desktop_session_at_path(
                    &session,
                    &cwd,
                    &native_id,
                    &native_path,
                    &items,
                    desktop_path,
                )?;
            }
            receipt
        }
        BoundNativeCatalogRefresh::Codex {
            receipt,
            cwd,
            native_id,
            native_path,
            title,
        } => {
            codex_native_catalog::synchronize_thread(
                &codex_native_app_home(),
                &native_path,
                &native_id,
                &cwd,
                &title,
                &[],
            )?;
            receipt
        }
    };
    // Generation-CAS: an older successful task never clears a newer terminal
    // request for the same native binding.
    persistence::acknowledge_native_catalog_refresh(&receipt)
        .map_err(|error| format!("acknowledge native App catalog refresh: {error}"))?;
    Ok(())
}

fn prepare_pending_native_catalog_refresh(
    pending: persistence::PendingNativeCatalogRefresh,
) -> Result<BoundNativeCatalogRefresh, String> {
    let session_id = pending.receipt.session_id.clone();
    let native_id = pending.receipt.cli_session_id.clone();
    let account_id = pending.receipt.account_id().map(str::to_string);
    let session = persistence::get_session(&session_id)
        .map_err(|error| format!("load CLI session {session_id}: {error}"))?
        .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
    let cwd = execution_cwd(&session)?;

    match pending.source.as_str() {
        "claude_code" => {
            let paths = existing_claude_native_paths(account_id.as_deref(), &cwd, &native_id)
                .ok_or_else(|| {
                    format!("no Claude transcript for pending native binding {native_id}")
                })?;
            let _transcript_guard = lock_claude_transcript(&paths.native_path)?;
            ensure_durable_runner_alias(&paths, &native_id)?;
            Ok(BoundNativeCatalogRefresh::Claude {
                receipt: pending.receipt,
                session_id,
                cwd,
                native_id,
                native_path: paths.native_path,
                runner_path: paths.runner_path,
                branch: session.branch,
            })
        }
        "codex_app" => {
            let account_id = account_id.as_deref().ok_or_else(|| {
                format!("pending Codex native binding {native_id} has no local account")
            })?;
            let paths = existing_codex_native_paths(account_id, &native_id)?.ok_or_else(|| {
                format!("no Codex rollout for pending native binding {native_id}")
            })?;
            ensure_durable_runner_alias(&paths, &native_id)?;
            Ok(BoundNativeCatalogRefresh::Codex {
                receipt: pending.receipt,
                cwd,
                native_id,
                native_path: paths.native_path,
                title: if session.name.trim().is_empty() {
                    "Imported conversation".to_string()
                } else {
                    session.name
                },
            })
        }
        source => Err(format!(
            "unsupported pending native App catalog source {source}"
        )),
    }
}

const STARTUP_NATIVE_CATALOG_REPAIR_LIMIT: usize = 64;

/// One bounded, pending-only reconciliation pass on app startup. This is a
/// durable retry point for terminal fire-and-forget catalog work, not a poller:
/// no clean session or provider transcript is scanned.
pub(crate) async fn reconcile_pending_native_catalog_refreshes_on_startup() -> (usize, usize) {
    let pending = match tokio::task::spawn_blocking(|| {
        persistence::pending_native_catalog_refreshes(STARTUP_NATIVE_CATALOG_REPAIR_LIMIT)
    })
    .await
    {
        Ok(Ok(pending)) => pending,
        Ok(Err(error)) => {
            tracing::warn!(error = %error, "failed to load pending native App catalog refreshes");
            return (0, 1);
        }
        Err(error) => {
            tracing::warn!(error = %error, "pending native App catalog query task failed");
            return (0, 1);
        }
    };

    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for pending in pending {
        let session_id = pending.receipt.session_id.clone();
        let mutation_guards = match lock_idle_native_mutation(&session_id).await {
            Ok(guards) => guards,
            Err(error) => {
                failed += 1;
                tracing::warn!(session_id, error = %error, "deferred pending native App catalog repair");
                continue;
            }
        };
        let prepared = tokio::task::spawn_blocking(move || {
            let _mutation_guards = mutation_guards;
            prepare_pending_native_catalog_refresh(pending)
        })
        .await;
        let refresh = match prepared {
            Ok(Ok(refresh)) => refresh,
            Ok(Err(error)) => {
                failed += 1;
                tracing::warn!(session_id, error = %error, "failed to prepare pending native App catalog repair");
                continue;
            }
            Err(error) => {
                failed += 1;
                tracing::warn!(session_id, error = %error, "pending native App catalog preparation task failed");
                continue;
            }
        };
        match tokio::task::spawn_blocking(move || refresh_bound_native_catalog(refresh)).await {
            Ok(Ok(())) => succeeded += 1,
            Ok(Err(error)) => {
                failed += 1;
                tracing::warn!(session_id, error = %error, "failed to repair pending native App catalog");
            }
            Err(error) => {
                failed += 1;
                tracing::warn!(session_id, error = %error, "pending native App catalog repair task failed");
            }
        }
    }
    (succeeded, failed)
}

/// Finalize the durable transcript now and refresh discovery metadata after the
/// current runner releases its identity guard. The background refresh is
/// idempotent and never delays the footer or the next provider turn.
pub(super) async fn converge_bound_native_transcript_and_schedule_catalog(
    session_id: &str,
) -> Result<bool, String> {
    let converge_session_id = session_id.to_string();
    let refresh =
        tokio::task::spawn_blocking(move || converge_bound_native_transcript(&converge_session_id))
            .await
            .map_err(|error| format!("native transcript convergence task failed: {error}"))??;
    let Some(refresh) = refresh else {
        return Ok(false);
    };

    let boundary_session_id = session_id.to_string();
    tokio::spawn(async move {
        // The caller's runner owns this lock. Waiting for and immediately
        // dropping it establishes an after-finalization boundary without
        // holding the lock during catalog I/O. If the next turn wins the race,
        // its provider work remains authoritative and refresh waits harmlessly.
        let identity = super::session_runner::session_identity_lock(&boundary_session_id)
            .await
            .lock_owned()
            .await;
        drop(identity);
        match tokio::task::spawn_blocking(move || refresh_bound_native_catalog(refresh)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => tracing::warn!(
                session_id = %boundary_session_id,
                error = %error,
                "failed to refresh provider-native App catalog"
            ),
            Err(error) => tracing::warn!(
                session_id = %boundary_session_id,
                error = %error,
                "native App catalog refresh task failed"
            ),
        }
    });
    Ok(true)
}

#[cfg(test)]
fn publish_bound_native_transcript(session_id: &str) -> Result<bool, String> {
    let Some(refresh) = converge_bound_native_transcript(session_id)? else {
        return Ok(false);
    };
    refresh_bound_native_catalog(refresh)?;
    Ok(true)
}

fn synchronize_native_agent(
    session_id: &str,
    complete_items: &[NativeConversationItem],
    append_items: &[NativeConversationItem],
) -> Result<NativeMaterializationReceipt, String> {
    agent_core::session::persistence::get_session(session_id)
        .map_err(|err| format!("load native Agent session {session_id}: {err}"))?
        .ok_or_else(|| format!("native Agent session {session_id} does not exist"))?;
    let receipt = agent_core::session::persistence::append_session_with_materialized_history(
        session_id,
        &native_agent_seeds(session_id, append_items),
    )
    .map_err(|err| format!("append native Agent transcript {session_id}: {err}"))?;
    if receipt.row_count != append_items.len() {
        return Err(format!(
            "native Agent append persisted {} of {} canonical suffix items",
            receipt.row_count,
            append_items.len()
        ));
    }
    Ok(NativeMaterializationReceipt {
        native_session_id: session_id.to_string(),
        item_count: complete_items.len(),
    })
}

async fn materialize_native_conversation_with_owner(
    state: Option<&AgentAppState>,
    session_id: String,
    items: Vec<NativeConversationItem>,
) -> Result<NativeMaterializationReceipt, String> {
    validate_items(&items)?;
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        // Move both guards into the blocking mutation. If the IPC future is
        // cancelled after spawning, filesystem work stays serialized until
        // it actually finishes instead of racing a follow-up.
        let mutation_guards = lock_idle_native_mutation(&session_id).await?;
        return tokio::task::spawn_blocking(move || {
            let _mutation_guards = mutation_guards;
            materialize_cli(&session_id, &items)
        })
        .await
        .map_err(|err| format!("native materialization task failed: {err}"))?;
    }

    let state = state
        .ok_or_else(|| format!("Agent materialization for {session_id} requires AgentAppState"))?;
    let operation_session_id = session_id.clone();
    run_agent_native_maintenance(state, session_id, move || {
        materialize_native_agent(&operation_session_id, &items)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn materialize_native_conversation(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    items: Vec<NativeConversationItem>,
) -> Result<NativeMaterializationReceipt, String> {
    materialize_native_conversation_with_owner(Some(state.inner()), session_id, items).await
}

fn synchronize_native_conversation_blocking(
    session_id: &str,
    complete_items: &[NativeConversationItem],
) -> Result<NativeMaterializationReceipt, String> {
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        let session = persistence::get_session(session_id)
            .map_err(|error| format!("load CLI session {session_id}: {error}"))?
            .ok_or_else(|| format!("CLI session {session_id} does not exist"))?;
        let account_id = session
            .account_id
            .as_deref()
            .filter(|value| !value.trim().is_empty());
        let native_id = persistence::get_cli_session_id_for_account(session_id, account_id)
            .map_err(|error| format!("read native binding for {session_id}: {error}"))?;
        if native_id.is_none() {
            if complete_items.is_empty() {
                // An empty canonical prefix has nothing to materialize.
                // Keep the fresh episode unbound so its first real user
                // turn lets the provider create a valid native UUID.
                return Ok(NativeMaterializationReceipt {
                    native_session_id: String::new(),
                    item_count: 0,
                });
            }
            // A freshly created execution episode has no provider UUID yet,
            // so there is no authoritative native prefix to compare.
            return materialize_cli(session_id, complete_items);
        }
        if let Some(native_id) = native_id.as_deref() {
            if load_materialized_cli_transcript(&session, native_id)?.is_none() {
                // The resume row doubles as the materialization intent. A
                // missing artifact means the process died before publication;
                // clear that incomplete intent and replay through the ordinary
                // materializer instead of leaving the episode permanently
                // bound to a UUID that no provider can open.
                persistence::clear_staged_cli_session_id_for_account(
                    session_id, account_id, native_id,
                )
                .map_err(|error| {
                    format!("clear incomplete native materialization intent: {error}")
                })?;
                return materialize_cli(session_id, complete_items);
            }
        }
    }
    let append_items = authoritative_append_suffix(session_id, complete_items)?;
    if append_items.is_empty() {
        if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
            return synchronize_cli(session_id, complete_items, &[]);
        }
        return Ok(NativeMaterializationReceipt {
            native_session_id: session_id.to_string(),
            item_count: complete_items.len(),
        });
    }
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        synchronize_cli(session_id, complete_items, &append_items)
    } else {
        synchronize_native_agent(session_id, complete_items, &append_items)
    }
}

async fn synchronize_native_conversation_with_owner(
    state: Option<&AgentAppState>,
    session_id: String,
    complete_items: Vec<NativeConversationItem>,
) -> Result<NativeMaterializationReceipt, String> {
    validate_items(&complete_items)?;
    if session_id.starts_with(core_types::session::CLI_SESSION_PREFIX) {
        let mutation_guards = lock_idle_native_mutation(&session_id).await?;
        return tokio::task::spawn_blocking(move || {
            let _mutation_guards = mutation_guards;
            synchronize_native_conversation_blocking(&session_id, &complete_items)
        })
        .await
        .map_err(|err| format!("native synchronization task failed: {err}"))?;
    }

    let state = state
        .ok_or_else(|| format!("Agent synchronization for {session_id} requires AgentAppState"))?;
    let operation_session_id = session_id.clone();
    run_agent_native_maintenance(state, session_id, move || {
        synchronize_native_conversation_blocking(&operation_session_id, &complete_items)
    })
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn synchronize_native_conversation(
    state: tauri::State<'_, AgentAppState>,
    session_id: String,
    complete_items: Vec<NativeConversationItem>,
) -> Result<NativeMaterializationReceipt, String> {
    synchronize_native_conversation_with_owner(Some(state.inner()), session_id, complete_items)
        .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn discard_native_conversation_materialization(
    session_id: String,
    native_session_id: String,
) -> Result<bool, String> {
    let mutation_guards = lock_idle_native_mutation(&session_id).await?;
    let result = tokio::task::spawn_blocking(move || {
        let _mutation_guards = mutation_guards;
        discard_cli_materialization(&session_id, &native_session_id)
    })
    .await
    .map_err(|err| format!("native materialization rollback task failed: {err}"))?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::test_env;
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[cfg(unix)]
    const CLAUDE_INDEX_LOCK_CHILD_CWD: &str = "ORGII_TEST_CLAUDE_INDEX_LOCK_CHILD_CWD";
    #[cfg(unix)]
    const CLAUDE_INDEX_LOCK_CHILD_READY: &str = "ORGII_TEST_CLAUDE_INDEX_LOCK_CHILD_READY";
    #[cfg(unix)]
    const CLAUDE_INDEX_LOCK_CHILD_ACTION: &str = "ORGII_TEST_CLAUDE_INDEX_LOCK_CHILD_ACTION";

    struct EnvVarGuard {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl EnvVarGuard {
        fn set(key: &'static str, value: &Path) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn message(id: &str, role: &str, text: &str) -> NativeConversationItem {
        NativeConversationItem::Message {
            id: id.to_string(),
            role: role.to_string(),
            text: text.to_string(),
            images: Vec::new(),
            created_at: "2026-09-02T00:00:00Z".to_string(),
            turn_id: None,
        }
    }

    fn tool_call(call_id: &str, name: &str, arguments: &str) -> NativeConversationItem {
        NativeConversationItem::ToolCall {
            id: format!("{call_id}:call"),
            call_id: call_id.to_string(),
            name: name.to_string(),
            arguments: arguments.to_string(),
            created_at: "2026-09-02T00:00:01Z".to_string(),
        }
    }

    fn tool_result(
        call_id: &str,
        name: &str,
        output: &str,
        is_error: bool,
        interrupted: bool,
    ) -> NativeConversationItem {
        NativeConversationItem::ToolResult {
            id: format!("{call_id}:result"),
            call_id: call_id.to_string(),
            name: name.to_string(),
            output: output.to_string(),
            is_error,
            interrupted,
            created_at: "2026-09-02T00:00:02Z".to_string(),
        }
    }

    fn create_native_claude_session(session_id: &str, account_id: &str, repo_path: &Path) {
        create_native_session(session_id, "claude_code", Some(account_id), repo_path);
    }

    fn create_native_session(
        session_id: &str,
        cli_agent_type: &str,
        account_id: Option<&str>,
        repo_path: &Path,
    ) {
        persistence::create_session(
            session_id,
            &persistence::CreateCodeSessionParams {
                name: Some("Native synchronization fixture".to_string()),
                flow: None,
                runner: None,
                cli_agent_type: cli_agent_type.to_string(),
                model: Some("claude-sonnet-4-6".to_string()),
                tier: None,
                account_id: account_id.map(str::to_string),
                repo_path: Some(repo_path.to_string_lossy().into_owned()),
                branch: None,
                worktree_path: None,
                worktree_base_ref: None,
                proxy_token: None,
                proxy_url: None,
                hosted_token: None,
                proxy_session_id: None,
                isolate: None,
                background: Some(false),
                key_source: Some("own_key".to_string()),
                additional_directories: None,
                parent_session_id: None,
                org_member_id: None,
                agent_definition_id: None,
                org_id: None,
                project_id: None,
                project_name: None,
                project_slug: None,
                work_item_id: None,
                agent_role: None,
                product_mode: None,
            },
        )
        .expect("create fresh native CLI episode");
    }

    #[test]
    fn unresolved_provider_tool_call_is_not_a_portable_item() {
        let mut chunk = ActivityChunk::new("source", "tool_call", "read_file");
        chunk.chunk_id = "partial-tool".to_string();
        chunk.args = json!({"path": "README.md"});
        chunk.result = json!({
            "status": "pending",
            "interrupted": true,
            "success": false,
            "call_id": "call_partial"
        });

        assert!(native_items_from_chunks(&[chunk]).is_empty());
    }

    #[test]
    fn dangling_claude_tool_use_does_not_forge_a_result_item() {
        let sandbox = test_env::sandbox();
        let native_id = "77777777-1111-4222-8333-999999999999";
        let path = sandbox.path().join("dangling-tool-use.jsonl");
        let items = vec![
            message("dangling-user", "user", "run the suite"),
            tool_call("call_resolved", "list_files", "{\"path\":\".\"}"),
            tool_result("call_resolved", "list_files", "README.md", false, false),
        ];
        let mut records = claude_records(native_id, Path::new("/repo"), &items)
            .expect("render resolved Claude pair");
        // Claude Code records a user interrupt as a `tool_use` its transcript
        // never answers, so reading one back must not invent a result.
        records.push(json!({
            "type": "assistant",
            "uuid": "aaaaaaaa-2222-4333-8444-bbbbbbbbbbbb",
            "parentUuid": Value::Null,
            "isSidechain": false,
            "userType": "external",
            "sessionId": native_id,
            "cwd": "/repo",
            "timestamp": "2026-09-02T00:00:05Z",
            "message": {
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "call_interrupted",
                    "name": "list_files",
                    "input": {"path": "src"}
                }]
            }
        }));
        atomic_jsonl(&path, &records).expect("write Claude transcript with a dangling tool_use");

        let chunks =
            orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                native_id, &path,
            )
            .expect("read Claude transcript back");
        let round_tripped = native_items_from_chunks(&chunks);

        assert_eq!(round_tripped.len(), items.len());
        assert!(items
            .iter()
            .zip(&round_tripped)
            .all(|(left, right)| native_item_semantically_equal(left, right)));
    }

    #[test]
    fn interrupted_tool_result_round_trips_through_the_claude_transcript() {
        let sandbox = test_env::sandbox();
        let native_id = "88888888-1111-4222-8333-cccccccccccc";
        let path = sandbox.path().join("interrupted-tool.jsonl");
        let items = vec![
            message("interrupt-user", "user", "run the suite"),
            tool_call(
                "call_killed",
                "run_command_line",
                "{\"command\":\"cargo test\"}",
            ),
            tool_result(
                "call_killed",
                "run_command_line",
                "compiling org2\n",
                true,
                true,
            ),
            message("interrupt-follow-up", "user", "stop and summarize"),
        ];
        let records =
            claude_records(native_id, Path::new("/repo"), &items).expect("render Claude records");
        atomic_jsonl(&path, &records).expect("write Claude transcript");

        let chunks =
            orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                native_id, &path,
            )
            .expect("read Claude transcript back");
        let round_tripped = native_items_from_chunks(&chunks);

        assert_eq!(round_tripped.len(), items.len());
        assert!(matches!(
            &round_tripped[2],
            NativeConversationItem::ToolResult {
                output,
                is_error: true,
                ..
            } if output == "compiling org2\n"
        ));
        assert!(items
            .iter()
            .zip(&round_tripped)
            .all(|(left, right)| native_item_semantically_equal(left, right)));
    }

    #[test]
    fn failed_codex_tool_output_round_trips_as_a_failed_tool() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("rollout-failed-tool.jsonl");
        let items = vec![
            tool_call(
                "call_failed",
                "run_command_line",
                "{\"command\":\"cargo test\"}",
            ),
            tool_result("call_failed", "run_command_line", "boom\n", true, false),
            tool_call("call_ok", "list_files", "{\"path\":\".\"}"),
            tool_result("call_ok", "list_files", "README.md", false, false),
        ];
        let projected = codex_response_items(&items);
        assert_eq!(projected[3]["output"], "README.md");

        let rollout = projected
            .iter()
            .map(|payload| {
                json!({
                    "timestamp": "2026-09-02T00:00:03Z",
                    "type": "response_item",
                    "payload": payload
                })
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&path, format!("{rollout}\n")).expect("write Codex rollout");

        let chunks = orgtrack_core::sources::codex::app::load_codex_app_from_path(
            "codexapp-failed-tool",
            &path,
        )
        .expect("read Codex rollout back");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].result["is_error"], true);
        assert_eq!(chunks[0].result["output"], "boom\n");
        assert_eq!(chunks[1].result["success"], true);

        let round_tripped = native_items_from_chunks(&chunks);
        assert_eq!(round_tripped.len(), items.len());
        assert!(items
            .iter()
            .zip(&round_tripped)
            .all(|(left, right)| native_item_semantically_equal(left, right)));
    }

    #[test]
    fn interrupted_codex_tool_output_is_not_injected_as_a_success() {
        let items = vec![tool_result(
            "call_killed",
            "run_command_line",
            "compiling org2\n",
            true,
            true,
        )];
        let projected = codex_response_items(&items);
        assert_eq!(
            projected[0]["output"],
            json!({"exit_code": 130, "output": "compiling org2\n"}).to_string()
        );
    }

    #[test]
    fn latest_compact_boundary_replaces_superseded_effective_context() {
        let mut before = ActivityChunk::new("source", "message", "user_message");
        before.chunk_id = "before".to_string();
        before.result = json!({"content": "superseded prompt"});
        let mut compact = ActivityChunk::new("source", "context_compacted", "context_compacted");
        compact.chunk_id = "compact-1".to_string();
        compact.result = json!({"observation": "repository summary"});
        let mut after = ActivityChunk::new("source", "message", "user_message");
        after.chunk_id = "after".to_string();
        after.result = json!({"content": "continue"});

        let items = native_items_from_chunks(&[before, compact, after]);
        assert_eq!(items.len(), 2);
        assert!(matches!(
            &items[0],
            NativeConversationItem::ContextSummary { summary, .. }
                if summary == "repository summary"
        ));
        let records = claude_records("native-compact", Path::new("/repo"), &items)
            .expect("serialize effective Claude context");
        assert_eq!(records[0]["subtype"], "compact_boundary");
        assert_eq!(records[1]["isCompactSummary"], true);
        assert_eq!(records[1]["message"]["content"], "repository summary");
    }

    #[test]
    fn missing_claude_resume_checkpoint_is_repaired_idempotently() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("missing-checkpoint.jsonl");
        let native_id = "99999999-1111-4222-8333-aaaaaaaaaaaa";
        let items = vec![message("checkpoint-user", "user", "continue")];
        let records =
            claude_records(native_id, Path::new("/repo"), &items).expect("serialize Claude rows");
        atomic_jsonl(&path, &records).expect("write rows without checkpoint");
        let _guard = lock_claude_transcript(&path).expect("lock transcript");

        ensure_claude_native_metadata(&path, native_id, &items, "")
            .expect("repair missing checkpoint");
        let once = fs::read_to_string(&path).expect("read repaired transcript");
        ensure_claude_native_metadata(&path, native_id, &items, "")
            .expect("repeat checkpoint repair");
        let twice = fs::read_to_string(&path).expect("read idempotent transcript");

        assert_eq!(once, twice);
        assert_eq!(once.lines().count(), 2);
        let checkpoint: Value =
            serde_json::from_str(once.lines().last().unwrap()).expect("decode repaired checkpoint");
        assert_eq!(checkpoint["type"], "last-prompt");
        assert_eq!(
            checkpoint["leafUuid"],
            records.last().expect("message record")["uuid"]
        );
    }

    #[test]
    fn claude_materialization_title_is_native_metadata_not_a_conversation_item() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("materialized-title.jsonl");
        let native_id = "12345678-1111-4222-8333-aaaaaaaaaaaa";
        let items = vec![
            message("title-user", "user", "inspect the repository"),
            message("title-assistant", "assistant", "I will inspect it."),
        ];
        let records = claude_materialization_records(
            native_id,
            Path::new("/repo"),
            &items,
            "Canonical conversation title",
        )
        .expect("render titled Claude materialization");

        assert_eq!(records[0]["type"], "custom-title");
        assert_eq!(records[0]["customTitle"], "Canonical conversation title");
        assert_eq!(records[0]["sessionId"], native_id);
        assert_eq!(
            records
                .iter()
                .filter(|record| record["type"] == "custom-title")
                .count(),
            1
        );

        atomic_jsonl(&path, &records).expect("write titled Claude transcript");
        let chunks =
            orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                native_id, &path,
            )
            .expect("read titled Claude transcript");
        let round_tripped = native_items_from_chunks(&chunks);
        assert_eq!(round_tripped.len(), items.len());
        assert!(items
            .iter()
            .zip(&round_tripped)
            .all(|(left, right)| native_item_semantically_equal(left, right)));
    }

    #[test]
    fn missing_claude_custom_title_is_repaired_once_for_orgii_materialization() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("missing-title.jsonl");
        let native_id = "22345678-1111-4222-8333-aaaaaaaaaaaa";
        let items = vec![message("title-user", "user", "continue")];
        let records = claude_records_with_resume_checkpoint(native_id, Path::new("/repo"), &items)
            .expect("serialize untitled Claude materialization");
        atomic_jsonl(&path, &records).expect("write untitled Claude materialization");
        let _guard = lock_claude_transcript(&path).expect("lock transcript");

        ensure_claude_native_metadata(&path, native_id, &items, "Canonical title")
            .expect("repair missing title");
        let once = fs::read_to_string(&path).expect("read repaired transcript");
        ensure_claude_native_metadata(&path, native_id, &items, "Canonical title")
            .expect("repeat title repair");
        let twice = fs::read_to_string(&path).expect("read idempotent transcript");

        assert_eq!(once, twice);
        let custom_titles = once
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("decode Claude record"))
            .filter(|record| record["type"] == "custom-title")
            .collect::<Vec<_>>();
        assert_eq!(custom_titles.len(), 1);
        assert_eq!(custom_titles[0]["customTitle"], "Canonical title");
        assert_eq!(custom_titles[0]["sessionId"], native_id);
    }

    #[test]
    fn claude_metadata_repair_does_not_title_unmanaged_native_transcript() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("provider-owned.jsonl");
        let native_id = "32345678-1111-4222-8333-aaaaaaaaaaaa";
        let items = vec![message("provider-user", "user", "provider-owned")];
        let mut records = claude_records(native_id, Path::new("/repo"), &items)
            .expect("serialize provider transcript fixture");
        for record in &mut records {
            record
                .as_object_mut()
                .expect("Claude record object")
                .remove("entrypoint");
        }
        atomic_jsonl(&path, &records).expect("write provider-owned transcript");
        let before = fs::read(&path).expect("read provider-owned transcript");
        let _guard = lock_claude_transcript(&path).expect("lock transcript");

        ensure_claude_native_metadata(&path, native_id, &items, "Must not be applied")
            .expect("inspect provider-owned transcript");

        assert_eq!(
            fs::read(&path).expect("read untouched provider transcript"),
            before
        );
    }

    #[test]
    fn claude_metadata_repair_preserves_existing_custom_title() {
        let sandbox = test_env::sandbox();
        let path = sandbox.path().join("existing-title.jsonl");
        let native_id = "42345678-1111-4222-8333-aaaaaaaaaaaa";
        let items = vec![message("existing-title-user", "user", "continue")];
        let mut records =
            claude_records_with_resume_checkpoint(native_id, Path::new("/repo"), &items)
                .expect("serialize titled Claude materialization");
        records.insert(0, claude_custom_title(native_id, "Existing title"));
        atomic_jsonl(&path, &records).expect("write titled Claude materialization");
        let before = fs::read(&path).expect("read titled transcript");
        let _guard = lock_claude_transcript(&path).expect("lock transcript");

        ensure_claude_native_metadata(&path, native_id, &items, "Replacement title")
            .expect("inspect existing title");

        assert_eq!(
            fs::read(&path).expect("read preserved titled transcript"),
            before
        );
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "launched by claude_project_index_rmw_is_locked_across_processes"]
    fn claude_project_index_lock_child() {
        let Some(cwd) = std::env::var_os(CLAUDE_INDEX_LOCK_CHILD_CWD).map(PathBuf::from) else {
            return;
        };
        let ready = PathBuf::from(
            std::env::var_os(CLAUDE_INDEX_LOCK_CHILD_READY)
                .expect("cross-process lock child ready marker"),
        );
        fs::write(&ready, b"ready").expect("write cross-process lock child ready marker");
        let native_id = "44444444-5555-4666-8777-888888888888";
        match std::env::var(CLAUDE_INDEX_LOCK_CHILD_ACTION).as_deref() {
            Ok("remove") => remove_claude_project_index_entry(&cwd, native_id)
                .expect("child removes Claude project index entry"),
            _ => publish_claude_project_index(
                &cwd,
                native_id,
                &[message("child-user", "user", "published by child")],
                None,
            )
            .expect("child publishes Claude project index entry"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn claude_project_index_rmw_is_locked_across_processes() {
        use std::process::Command;
        use std::thread;
        use std::time::{Duration, Instant};

        let sandbox = test_env::sandbox();
        let cwd = sandbox.path().join("cross-process-claude-worktree");
        fs::create_dir_all(&cwd).expect("create cross-process Claude workspace");
        let native_id = "44444444-5555-4666-8777-888888888888";
        let index_path = claude_native_paths(None, &cwd, native_id)
            .native_path
            .parent()
            .expect("Claude project directory")
            .join("sessions-index.json");
        fs::create_dir_all(index_path.parent().expect("Claude index parent"))
            .expect("create Claude index parent");
        let ready = sandbox.path().join("claude-index-child-ready");
        let guard = lock_claude_project_index(&index_path).expect("lock Claude project index");

        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .arg("claude_project_index_lock_child")
            .arg("--ignored")
            .env(CLAUDE_INDEX_LOCK_CHILD_CWD, &cwd)
            .env(CLAUDE_INDEX_LOCK_CHILD_READY, &ready)
            .spawn()
            .expect("launch cross-process Claude index writer");

        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists(), "child must reach the locked RMW boundary");
        thread::sleep(Duration::from_millis(100));
        assert!(
            !index_path.exists(),
            "another process must not mutate the index while the advisory lock is held"
        );
        assert!(
            child.try_wait().expect("inspect child process").is_none(),
            "child should still be waiting for the cross-process lock"
        );

        drop(guard);
        let status = child.wait().expect("wait for cross-process index writer");
        assert!(status.success(), "cross-process index writer failed");
        let index: Value = serde_json::from_slice(
            &fs::read(&index_path).expect("read child-published Claude project index"),
        )
        .expect("decode child-published Claude project index");
        assert_eq!(index["entries"][0]["sessionId"].as_str(), Some(native_id));

        let survivor_id = "55555555-6666-4777-8888-999999999999";
        publish_claude_project_index(
            &cwd,
            survivor_id,
            &[message("survivor-user", "user", "must survive remove")],
            None,
        )
        .expect("publish peer index entry");
        let remove_ready = sandbox.path().join("claude-index-remove-child-ready");
        let guard = lock_claude_project_index(&index_path).expect("relock Claude project index");
        let mut child = Command::new(std::env::current_exe().expect("current test executable"))
            .arg("claude_project_index_lock_child")
            .arg("--ignored")
            .env(CLAUDE_INDEX_LOCK_CHILD_CWD, &cwd)
            .env(CLAUDE_INDEX_LOCK_CHILD_READY, &remove_ready)
            .env(CLAUDE_INDEX_LOCK_CHILD_ACTION, "remove")
            .spawn()
            .expect("launch cross-process Claude index remover");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !remove_ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(
            remove_ready.exists(),
            "remove child must reach the locked RMW boundary"
        );
        thread::sleep(Duration::from_millis(100));
        let locked_index = fs::read_to_string(&index_path).expect("read index while remove waits");
        assert!(
            locked_index.contains(native_id),
            "another process must not remove an entry while the advisory lock is held"
        );
        assert!(
            child.try_wait().expect("inspect remove child").is_none(),
            "remove child should still be waiting for the cross-process lock"
        );

        drop(guard);
        let status = child.wait().expect("wait for cross-process index remover");
        assert!(status.success(), "cross-process index remover failed");
        let index = fs::read_to_string(&index_path).expect("read index after child remove");
        assert!(!index.contains(native_id));
        assert!(
            index.contains(survivor_id),
            "removing one entry must preserve peer updates"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn agent_native_maintenance_waits_for_the_session_scheduler_owner() {
        let session_id = "sdeagent-native-maintenance-owner";
        let session = Arc::new(agent_core::state::AgentSession::new(
            session_id.to_string(),
            agent_core::definitions::sde_agent(),
        ));
        let release_first = Arc::new(tokio::sync::Notify::new());
        let release_first_task = Arc::clone(&release_first);
        let (first_started_tx, first_started_rx) = oneshot::channel();
        session
            .scheduler
            .enqueue(ScheduledMessage {
                kind: ScheduledKind::Maintenance,
                message_id: "blocking-maintenance".to_string(),
                generation: 0,
                client_message_id: None,
                turn_intent_id: String::new(),
                org_run_id: None,
                content: "[test maintenance]".to_string(),
                execute: Box::new(move || {
                    Box::pin(async move {
                        let _ = first_started_tx.send(());
                        release_first_task.notified().await;
                        Ok(String::new())
                    })
                }),
            })
            .await
            .expect("enqueue blocking maintenance");
        first_started_rx
            .await
            .expect("blocking maintenance should start");

        let mutation_ran = Arc::new(AtomicBool::new(false));
        let mutation_ran_task = Arc::clone(&mutation_ran);
        let session_task = Arc::clone(&session);
        let mutation = tokio::spawn(enqueue_agent_native_maintenance(
            session_task,
            session_id.to_string(),
            move || {
                mutation_ran_task.store(true, Ordering::Release);
                Ok(NativeMaterializationReceipt {
                    native_session_id: session_id.to_string(),
                    item_count: 1,
                })
            },
        ));
        tokio::task::yield_now().await;
        assert!(
            !mutation_ran.load(Ordering::Acquire),
            "native mutation must not bypass an active scheduler job"
        );

        release_first.notify_one();
        let receipt = mutation
            .await
            .expect("join native maintenance")
            .expect("native maintenance succeeds");
        assert!(mutation_ran.load(Ordering::Acquire));
        assert_eq!(receipt.native_session_id, session_id);
        assert_eq!(receipt.item_count, 1);
    }

    #[test]
    fn semantic_identity_ignores_provider_ids_and_timestamps() {
        let left = message("canonical", "user", "hello");
        let right = NativeConversationItem::Message {
            id: "provider".to_string(),
            role: "user".to_string(),
            text: "hello".to_string(),
            images: Vec::new(),
            created_at: "2027-01-01T00:00:00Z".to_string(),
            turn_id: None,
        };
        assert!(native_item_semantically_equal(&left, &right));
    }

    #[test]
    fn agent_history_preserves_embedded_user_images() {
        let history = vec![json!({
            "role": "user",
            "content": [
                {"type": "text", "text": "inspect"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,QUJD"}}
            ]
        })];
        let projected = native_items_from_agent_history(&history);
        assert!(matches!(
            &projected[0],
            NativeConversationItem::Message { text, images, .. }
                if text == "inspect" && images == &["data:image/png;base64,QUJD"]
        ));
    }

    #[test]
    fn codex_tool_arguments_are_not_polluted_with_orgii_fields() {
        let item = NativeConversationItem::ToolCall {
            id: "call-item".to_string(),
            call_id: "call_1".to_string(),
            name: "read_file".to_string(),
            arguments: r#"{"path":"README.md"}"#.to_string(),
            created_at: "2026-09-02T00:00:00Z".to_string(),
        };
        let projected = codex_response_items(&[item]);
        assert_eq!(projected[0]["arguments"], r#"{"path":"README.md"}"#);
        assert!(!projected[0]["arguments"]
            .as_str()
            .unwrap_or_default()
            .contains("__orgii"));
    }

    #[test]
    fn claude_project_index_preserves_unknown_fields_and_rejects_unknown_schema() {
        let sandbox = test_env::sandbox();
        let cwd = sandbox.path().join("claude-index-schema-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        let native_id = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
        let index_path = claude_native_paths(None, &cwd, native_id)
            .native_path
            .parent()
            .expect("Claude project directory")
            .join("sessions-index.json");
        fs::create_dir_all(index_path.parent().expect("Claude index parent"))
            .expect("create Claude index parent");
        fs::write(
            &index_path,
            serde_json::to_vec(&json!({
                "version": CLAUDE_PROJECT_INDEX_VERSION,
                "providerTopLevel": {"keep": true},
                "entries": [{
                    "sessionId": native_id,
                    "messageCount": 1,
                    "providerEntryField": {"keep": true}
                }]
            }))
            .expect("encode Claude index fixture"),
        )
        .expect("write Claude index fixture");

        publish_claude_project_index(
            &cwd,
            native_id,
            &[message("index-user", "user", "updated")],
            Some("feature/native-index"),
        )
        .expect("update supported Claude index schema");
        let updated: Value = serde_json::from_slice(
            &fs::read(&index_path).expect("read updated Claude project index"),
        )
        .expect("decode updated Claude project index");
        assert_eq!(updated["providerTopLevel"]["keep"], true);
        assert_eq!(updated["entries"][0]["providerEntryField"]["keep"], true);
        assert_eq!(updated["entries"][0]["gitBranch"], "feature/native-index");

        let unsupported = json!({
            "version": CLAUDE_PROJECT_INDEX_VERSION + 1,
            "entries": updated["entries"].clone()
        });
        fs::write(
            &index_path,
            serde_json::to_vec(&unsupported).expect("encode unsupported Claude index"),
        )
        .expect("write unsupported Claude index");
        let error = publish_claude_project_index(
            &cwd,
            native_id,
            &[message("new-user", "user", "must not overwrite")],
            None,
        )
        .expect_err("unknown Claude index schemas must fail closed");
        assert!(error.contains("unsupported Claude project index schema version"));
        let unchanged: Value = serde_json::from_slice(
            &fs::read(&index_path).expect("read rejected Claude project index"),
        )
        .expect("decode rejected Claude project index");
        assert_eq!(unchanged, unsupported);
    }

    #[test]
    fn claude_catalog_refresh_uses_provider_metadata_without_parsing_transcript() {
        let sandbox = test_env::sandbox();
        let cwd = sandbox.path().join("claude-provider-index-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        let native_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let paths = claude_native_paths(Some("anthropic-provider-index"), &cwd, native_id);
        assert_ne!(paths.native_path, paths.runner_path);
        fs::create_dir_all(
            paths
                .native_path
                .parent()
                .expect("native transcript parent"),
        )
        .expect("create native transcript parent");
        fs::create_dir_all(
            paths
                .runner_path
                .parent()
                .expect("runner transcript parent"),
        )
        .expect("create runner transcript parent");
        // Deliberately not valid Claude JSONL: taking the provider metadata path
        // must succeed without falling back to a transcript parse.
        fs::write(&paths.native_path, b"not-json\n").expect("write native transcript fixture");
        replace_runner_link(&paths.native_path, &paths.runner_path)
            .expect("link isolated runner to native transcript");
        let (file_mtime, _) =
            transcript_modified_metadata(&paths.native_path).expect("read fixture mtime");

        let native_index_path = paths
            .native_path
            .parent()
            .expect("native project directory")
            .join("sessions-index.json");
        fs::write(
            &native_index_path,
            serde_json::to_vec(&json!({
                "version": CLAUDE_PROJECT_INDEX_VERSION,
                "entries": [{
                    "sessionId": native_id,
                    "messageCount": 1,
                    "nativeUnknown": "keep"
                }]
            }))
            .expect("encode native index fixture"),
        )
        .expect("write native index fixture");
        let runner_index_path = paths
            .runner_path
            .parent()
            .expect("runner project directory")
            .join("sessions-index.json");
        fs::write(
            &runner_index_path,
            serde_json::to_vec(&json!({
                "version": CLAUDE_PROJECT_INDEX_VERSION,
                "entries": [{
                    "sessionId": native_id,
                    "fullPath": paths.runner_path,
                    "fileMtime": file_mtime,
                    "firstPrompt": "provider prompt",
                    "messageCount": 7,
                    "providerUnknown": "keep"
                }]
            }))
            .expect("encode provider index fixture"),
        )
        .expect("write provider index fixture");

        assert!(refresh_claude_project_index_from_provider(
            &cwd,
            native_id,
            &paths.native_path,
            &paths.runner_path,
            Some("feature/provider-index")
        )
        .expect("refresh native catalog from provider metadata"));
        let refreshed: Value = serde_json::from_slice(
            &fs::read(&native_index_path).expect("read refreshed native index"),
        )
        .expect("decode refreshed native index");
        let entry = &refreshed["entries"][0];
        assert_eq!(entry["messageCount"], 7);
        assert_eq!(entry["fileMtime"], file_mtime);
        assert_eq!(entry["fullPath"], json!(paths.native_path));
        assert_eq!(entry["workspacePath"], json!(cwd));
        assert_eq!(entry["nativeUnknown"], "keep");
        assert_eq!(entry["providerUnknown"], "keep");
        assert_eq!(entry["gitBranch"], "feature/provider-index");
    }

    #[test]
    fn cold_claude_lookup_falls_back_to_the_native_app_transcript() {
        let sandbox = test_env::sandbox();
        let account_id = "anthropic-cold-native-root";
        let native_id = "11111111-2222-4333-8444-555555555555";
        let cwd = sandbox.path().join("legacy-claude-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");

        let paths = claude_native_paths(Some(account_id), &cwd, native_id);
        assert_ne!(paths.native_path, paths.runner_path);
        fs::create_dir_all(paths.native_path.parent().expect("native Claude parent"))
            .expect("create legacy Claude transcript parent");
        fs::write(&paths.native_path, b"{}\n").expect("write legacy Claude transcript");

        let resolved = existing_claude_native_paths(Some(account_id), &cwd, native_id)
            .expect("cold lookup should retain an existing native-App transcript");
        assert_eq!(resolved.native_path, paths.native_path);
        assert_eq!(resolved.runner_path, paths.runner_path);
    }

    #[test]
    fn profile_only_claude_transcript_is_promoted_without_losing_bytes() {
        let sandbox = test_env::sandbox();
        let account_id = "anthropic-profile-only";
        let native_id = "22222222-3333-4444-8555-666666666666";
        let cwd = sandbox.path().join("profile-only-claude-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        let paths = claude_native_paths(Some(account_id), &cwd, native_id);
        fs::create_dir_all(paths.runner_path.parent().expect("runner parent"))
            .expect("create profile-only runner parent");
        let payload = serialize_jsonl(
            &claude_records_with_resume_checkpoint(
                native_id,
                &cwd,
                &[message("profile-user", "user", "preserve me")],
            )
            .expect("render Claude transcript"),
        )
        .expect("serialize Claude transcript");
        fs::write(&paths.runner_path, &payload).expect("write profile-only transcript");

        assert!(ensure_durable_runner_alias(&paths, native_id)
            .expect("promote profile-only transcript"));
        assert_eq!(
            fs::read(&paths.native_path).expect("read durable transcript"),
            payload
        );
        assert_eq!(
            fs::read(&paths.runner_path).expect("read runner alias"),
            payload
        );
        assert!(paths_match(&paths.native_path, &paths.runner_path));
    }

    #[test]
    fn claude_desktop_directory_scan_has_a_hard_entry_budget() {
        let sandbox = test_env::sandbox();
        let root = sandbox.path().join("claude-desktop-catalog");
        fs::create_dir_all(root.join("a-directory")).expect("create first catalog directory");
        fs::create_dir_all(root.join("b-directory")).expect("create second catalog directory");
        fs::write(root.join("c-row.json"), b"{}").expect("create first catalog row");
        fs::write(root.join("d-row.json"), b"{}").expect("create second catalog row");

        let mut budget = 2;
        let paths = bounded_directory_paths(&root, &mut budget);
        assert_eq!(paths.len(), 2);
        assert_eq!(budget, 0);
        assert!(bounded_directory_paths(&root, &mut budget).is_empty());
    }

    #[test]
    fn claude_desktop_uuid_lookup_crosses_accounts_but_new_rows_use_active_account() {
        let sandbox = test_env::sandbox();
        let _native_history = EnvVarGuard::set("ORGII_NATIVE_TRANSCRIPT_HOME", sandbox.path());
        let cwd = sandbox.path().join("shared-worktree");
        fs::create_dir_all(&cwd).expect("create shared Claude workspace");

        let sessions_root = claude_desktop_sessions_root();
        let inactive_project = sessions_root
            .join("11111111-1111-4111-8111-111111111111")
            .join("22222222-2222-4222-8222-222222222222");
        let active_project = sessions_root
            .join("33333333-3333-4333-8333-333333333333")
            .join("44444444-4444-4444-8444-444444444444");
        fs::create_dir_all(&inactive_project).expect("create inactive account project");
        fs::create_dir_all(&active_project).expect("create active account project");
        fs::write(
            sessions_root
                .parent()
                .expect("Claude data directory")
                .join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": "33333333-3333-4333-8333-333333333333"
            }))
            .expect("encode active account config"),
        )
        .expect("write active account config");

        let existing_native_id = "55555555-5555-4555-8555-555555555555";
        let existing_path = inactive_project.join(format!("local_{existing_native_id}.json"));
        fs::write(
            &existing_path,
            serde_json::to_vec(&json!({
                "sessionId": format!("local_{existing_native_id}"),
                "cliSessionId": existing_native_id,
                "cwd": cwd,
                "createdAt": 1,
                "lastActivityAt": 1
            }))
            .expect("encode inactive account row"),
        )
        .expect("write inactive account row");
        fs::write(
            active_project.join("local-active-seed.json"),
            serde_json::to_vec(&json!({
                "sessionId": "local-active-seed",
                "cliSessionId": "active-seed",
                "cwd": cwd,
                "createdAt": 2,
                "lastActivityAt": 2
            }))
            .expect("encode active account seed"),
        )
        .expect("write active account seed");

        assert_eq!(
            claude_desktop_session_path(&sessions_root, &cwd, existing_native_id),
            Some(existing_path),
            "an existing UUID must remain in its original account"
        );

        let new_native_id = "66666666-6666-4666-8666-666666666666";
        assert_eq!(
            claude_desktop_session_path(&sessions_root, &cwd, new_native_id),
            Some(active_project.join(format!("local_{new_native_id}.json"))),
            "a new row must be placed under the active account"
        );
    }

    #[test]
    fn finalizer_publication_promotes_fresh_claude_session_and_catalog() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-finalizer-publish";
        let account_id = "anthropic-finalizer-publish";
        let native_id = "33333333-4444-4555-8666-777777777777";
        let cwd = sandbox.path().join("finalizer-publish-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        create_native_claude_session(session_id, account_id, &cwd);
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), native_id)
            .expect("bind provider UUID");
        let session = persistence::get_session(session_id)
            .expect("load fresh native session")
            .expect("fresh native session exists");
        let canonical_cwd = execution_cwd(&session).expect("resolve provider cwd");
        let paths = claude_native_paths(Some(account_id), &canonical_cwd, native_id);
        fs::create_dir_all(paths.runner_path.parent().expect("runner parent"))
            .expect("create isolated runner transcript parent");
        let payload = serialize_jsonl(
            &claude_records_with_resume_checkpoint(
                native_id,
                &cwd,
                &[message("fresh-user", "user", "visible in Claude")],
            )
            .expect("render Claude transcript"),
        )
        .expect("serialize Claude transcript");
        fs::write(&paths.runner_path, &payload).expect("write isolated provider transcript");

        let desktop_root = claude_desktop_sessions_root();
        let desktop_project = desktop_root
            .join("11111111-1111-4111-8111-111111111111")
            .join("22222222-2222-4222-8222-222222222222");
        fs::create_dir_all(&desktop_project).expect("create provider-owned Desktop project");
        fs::write(
            desktop_root
                .parent()
                .expect("Claude data directory")
                .join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": "11111111-1111-4111-8111-111111111111"
            }))
            .expect("encode Desktop config"),
        )
        .expect("write Desktop config");
        fs::write(
            desktop_project.join("local-existing.json"),
            serde_json::to_vec(&json!({
                "sessionId": "local-existing",
                "cliSessionId": "existing",
                "cwd": cwd,
                "createdAt": 1,
                "lastActivityAt": 1
            }))
            .expect("encode existing Desktop row"),
        )
        .expect("seed provider-owned Desktop project row");

        assert!(publish_bound_native_transcript(session_id).expect("publish native transcript"));
        assert_eq!(
            fs::read(&paths.native_path).expect("read native App transcript"),
            payload
        );
        assert!(paths_match(&paths.native_path, &paths.runner_path));
        let index = fs::read_to_string(
            paths
                .native_path
                .parent()
                .expect("Claude project directory")
                .join("sessions-index.json"),
        )
        .expect("read Claude project index");
        assert!(index.contains(native_id));
        assert!(index.contains("visible in Claude"));
        let desktop_row: Value = serde_json::from_slice(
            &fs::read(desktop_project.join(format!("local_{native_id}.json")))
                .expect("read Claude Desktop discovery row"),
        )
        .expect("decode Claude Desktop discovery row");
        assert_eq!(desktop_row["sessionId"], format!("local_{native_id}"));
        assert_eq!(desktop_row["cliSessionId"], native_id);
        assert!(paths_match(
            Path::new(desktop_row["cwd"].as_str().expect("Desktop cwd")),
            &cwd
        ));
        assert_eq!(desktop_row["completedTurns"], 0);
        assert_eq!(desktop_row["orgiiMaterialization"], true);

        assert!(discard_cli_materialization(session_id, native_id)
            .expect("discard materialized Claude transcript"));
        assert!(
            !desktop_project
                .join(format!("local_{native_id}.json"))
                .exists(),
            "rollback must not leave a Desktop row pointing at a removed JSONL"
        );
    }

    #[test]
    fn explicit_native_home_survives_discovery_home_cleanup() {
        let sandbox = test_env::sandbox();
        let discovery_home = sandbox.path().join("disposable-discovery-home");
        let official_home = sandbox.path().join("official-provider-home");
        let cwd = sandbox.path().join("durable-native-worktree");
        fs::create_dir_all(&discovery_home).expect("create isolated discovery home");
        fs::create_dir_all(&official_home).expect("create official provider home");
        fs::create_dir_all(&cwd).expect("create Claude workspace");
        let _external_history = EnvVarGuard::set("ORGII_EXTERNAL_HISTORY_HOME", &discovery_home);
        let _native_history = EnvVarGuard::set("ORGII_NATIVE_TRANSCRIPT_HOME", &official_home);
        let native_id = "34343434-5656-4787-8989-abababababab";
        let items = vec![
            message("durable-user", "user", "survive discovery cleanup"),
            message("durable-assistant", "assistant", "still openable"),
        ];
        let paths = claude_native_paths(None, &cwd, native_id);
        let records = claude_records_with_resume_checkpoint(native_id, &cwd, &items)
            .expect("render Claude transcript");

        let desktop_root = claude_desktop_sessions_root();
        let desktop_project = desktop_root
            .join("33333333-3333-4333-8333-333333333333")
            .join("44444444-4444-4444-8444-444444444444");
        fs::create_dir_all(&desktop_project).expect("create official Desktop project");
        fs::write(
            desktop_root
                .parent()
                .expect("Claude data directory")
                .join("config.json"),
            serde_json::to_vec(&json!({
                "lastKnownAccountUuid": "33333333-3333-4333-8333-333333333333"
            }))
            .expect("encode official Desktop config"),
        )
        .expect("write official Desktop config");
        fs::write(
            desktop_project.join("local-existing.json"),
            serde_json::to_vec(&json!({
                "sessionId": "local-existing",
                "cliSessionId": "existing",
                "cwd": cwd,
                "createdAt": 1,
                "lastActivityAt": 1
            }))
            .expect("encode official Desktop seed"),
        )
        .expect("seed official Desktop project");
        let session_id = "cliagent-durable-native-desktop-proof";
        create_native_claude_session(session_id, "anthropic-durable-proof", &cwd);
        let session = persistence::get_session(session_id)
            .expect("load durable Desktop proof session")
            .expect("durable Desktop proof session exists");

        write_native_store_jsonl(&paths, &records).expect("publish official Claude transcript");
        publish_claude_project_index(&cwd, native_id, &items, Some("feature/native-proof"))
            .expect("publish official Claude project index");
        publish_claude_desktop_session(&session, &cwd, native_id, &paths.native_path, &items)
            .expect("publish official Claude Desktop metadata")
            .expect("matching provider-owned Desktop project");
        fs::remove_dir_all(&discovery_home).expect("delete isolated discovery home");

        assert!(paths.native_path.starts_with(&official_home));
        assert!(paths.native_path.is_file());
        let parsed =
            orgtrack_core::sources::claude_code::history::load_claude_code_history_from_path(
                "claudecodeapp-durable-proof",
                &paths.native_path,
            )
            .expect("open published Claude transcript after discovery cleanup");
        assert!(parsed.iter().any(|chunk| {
            chunk.function == "assistant" && chunk.result.to_string().contains("still openable")
        }));

        let index_path = paths
            .native_path
            .parent()
            .expect("Claude project directory")
            .join("sessions-index.json");
        let index: Value = serde_json::from_slice(
            &fs::read(&index_path).expect("read durable Claude project index"),
        )
        .expect("decode durable Claude project index");
        let entry = index["entries"]
            .as_array()
            .expect("Claude project index entries")
            .iter()
            .find(|entry| entry["sessionId"].as_str() == Some(native_id))
            .expect("durable Claude project index entry");
        assert_eq!(entry["fullPath"], json!(paths.native_path));
        assert!(Path::new(entry["fullPath"].as_str().expect("indexed path")).is_file());
        assert_eq!(entry["workspacePath"], json!(cwd));
        let desktop_row = desktop_project.join(format!("local_{native_id}.json"));
        assert!(desktop_row.starts_with(&official_home));
        let desktop_row: Value = serde_json::from_slice(
            &fs::read(desktop_row).expect("read durable Claude Desktop metadata"),
        )
        .expect("decode durable Claude Desktop metadata");
        assert_eq!(desktop_row["cliSessionId"], native_id);
        assert!(paths_match(
            Path::new(desktop_row["cwd"].as_str().expect("Desktop cwd")),
            &cwd
        ));
        assert_eq!(desktop_row["completedTurns"], 1);
    }

    #[test]
    fn finalizer_refreshes_claude_catalog_after_normal_linked_append() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-finalizer-linked-append";
        let account_id = "anthropic-finalizer-linked-append";
        let native_id = "44444444-5555-4666-8777-888888888888";
        let cwd = sandbox.path().join("finalizer-linked-append-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        create_native_claude_session(session_id, account_id, &cwd);
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), native_id)
            .expect("bind provider UUID");
        let session = persistence::get_session(session_id)
            .expect("load native session")
            .expect("native session exists");
        let canonical_cwd = execution_cwd(&session).expect("resolve provider cwd");
        let paths = claude_native_paths(Some(account_id), &canonical_cwd, native_id);
        fs::create_dir_all(
            paths
                .native_path
                .parent()
                .expect("native transcript parent"),
        )
        .expect("create native transcript parent");
        fs::create_dir_all(
            paths
                .runner_path
                .parent()
                .expect("runner transcript parent"),
        )
        .expect("create runner transcript parent");
        let payload = serialize_jsonl(
            &claude_records_with_resume_checkpoint(
                native_id,
                &cwd,
                &[message("linked-user", "user", "normal linked append")],
            )
            .expect("render Claude transcript"),
        )
        .expect("serialize Claude transcript");
        fs::write(&paths.native_path, &payload).expect("write native provider transcript");
        replace_runner_link(&paths.native_path, &paths.runner_path)
            .expect("link isolated runner to native transcript");
        let (file_mtime, _) =
            transcript_modified_metadata(&paths.native_path).expect("read transcript mtime");
        let runner_index_path = paths
            .runner_path
            .parent()
            .expect("runner project directory")
            .join("sessions-index.json");
        fs::write(
            &runner_index_path,
            serde_json::to_vec(&json!({
                "version": CLAUDE_PROJECT_INDEX_VERSION,
                "entries": [{
                    "sessionId": native_id,
                    "fullPath": paths.runner_path,
                    "fileMtime": file_mtime,
                    "firstPrompt": "normal linked append",
                    "messageCount": 9
                }]
            }))
            .expect("encode runner index"),
        )
        .expect("write runner index");

        // The alias already points at the durable transcript, so convergence
        // performs no promotion. Claude catalog refresh must still be returned.
        assert!(publish_bound_native_transcript(session_id)
            .expect("publish normal linked provider append"));
        let native_index_path = paths
            .native_path
            .parent()
            .expect("native project directory")
            .join("sessions-index.json");
        let index: Value = serde_json::from_slice(
            &fs::read(native_index_path).expect("read refreshed native index"),
        )
        .expect("decode refreshed native index");
        assert_eq!(index["entries"][0]["sessionId"], native_id);
        assert_eq!(index["entries"][0]["messageCount"], 9);
        assert_eq!(index["entries"][0]["fileMtime"], file_mtime);
    }

    #[test]
    fn divergent_native_and_runner_transcripts_fail_closed() {
        let sandbox = test_env::sandbox();
        let paths = NativeTranscriptPaths {
            native_path: sandbox.path().join("native.jsonl"),
            runner_path: sandbox.path().join("runner.jsonl"),
        };
        fs::write(
            &paths.native_path,
            b"{\"sessionId\":\"native-1\"}\n{\"message\":\"left\"}\n",
        )
        .expect("write native transcript");
        fs::write(
            &paths.runner_path,
            b"{\"sessionId\":\"native-1\"}\n{\"message\":\"right\"}\n",
        )
        .expect("write runner transcript");

        let error = preferred_materialized_transcript_path(&paths)
            .expect_err("two independently advanced transcripts must not be guessed by mtime");
        assert!(error.contains("both advanced"));
    }

    #[test]
    fn convergence_skips_a_codex_session_without_a_local_account() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-converge-codex-ambient";
        let native_id = "bbbbbbbb-1111-4222-8333-dddddddddddd";
        create_native_session(session_id, "codex", None, sandbox.path());
        persistence::update_cli_session_id_for_account(session_id, None, native_id)
            .expect("bind provider UUID without a local account");

        assert!(converge_bound_native_transcript(session_id)
            .expect("a hosted-key Codex session is missing evidence, not diverged")
            .is_none());
    }

    #[test]
    fn convergence_skips_a_bound_session_with_no_provider_transcript() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-converge-no-transcript";
        let account_id = "anthropic-converge-no-transcript";
        let native_id = "cccccccc-1111-4222-8333-eeeeeeeeeeee";
        create_native_claude_session(session_id, account_id, sandbox.path());
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), native_id)
            .expect("bind provider UUID");

        assert!(converge_bound_native_transcript(session_id)
            .expect("an unwritten provider transcript must not fail the turn closed")
            .is_none());
    }

    #[test]
    fn convergence_still_fails_closed_on_a_divergent_bound_transcript() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-converge-divergent";
        let account_id = "anthropic-converge-divergent";
        let native_id = "dddddddd-1111-4222-8333-ffffffffffff";
        let cwd = sandbox.path().join("converge-divergent-worktree");
        fs::create_dir_all(&cwd).expect("create Claude fixture workspace");
        create_native_claude_session(session_id, account_id, &cwd);
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), native_id)
            .expect("bind provider UUID");
        let session = persistence::get_session(session_id)
            .expect("load bound native session")
            .expect("bound native session exists");
        let canonical_cwd = execution_cwd(&session).expect("resolve provider cwd");
        let paths = claude_native_paths(Some(account_id), &canonical_cwd, native_id);
        for path in [&paths.native_path, &paths.runner_path] {
            fs::create_dir_all(path.parent().expect("transcript parent"))
                .expect("create transcript parent");
        }
        fs::write(
            &paths.native_path,
            format!("{{\"sessionId\":\"{native_id}\"}}\n{{\"message\":\"left\"}}\n"),
        )
        .expect("write native App transcript");
        fs::write(
            &paths.runner_path,
            format!("{{\"sessionId\":\"{native_id}\"}}\n{{\"message\":\"right\"}}\n"),
        )
        .expect("write isolated runner transcript");

        let error = converge_bound_native_transcript(session_id)
            .expect_err("two independently advanced copies of one UUID are a proven divergence");
        assert!(error.contains("both advanced"), "unexpected error: {error}");
    }

    #[test]
    fn cold_codex_lookup_falls_back_to_the_native_app_transcript() {
        let sandbox = test_env::sandbox();
        let account_id = "codex-cold-native-root";
        let native_id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        let legacy_path = codex_native_app_sessions_root()
            .join("2026")
            .join("09")
            .join("03")
            .join(format!("rollout-2026-09-03T00-00-00-{native_id}.jsonl"));
        assert!(legacy_path.starts_with(sandbox.path()));
        fs::create_dir_all(legacy_path.parent().expect("legacy Codex parent"))
            .expect("create legacy Codex transcript parent");
        fs::write(&legacy_path, b"{}\n").expect("write legacy Codex transcript");

        let cache_key = (account_id.to_string(), native_id.to_string());
        CODEX_NATIVE_PATH_CACHE
            .lock()
            .expect("lock Codex native path cache")
            .remove(&cache_key);
        let resolved = existing_codex_native_paths(account_id, native_id)
            .expect("scan Codex native roots")
            .expect("cold lookup should retain an existing native-App rollout");
        assert_eq!(resolved.native_path, legacy_path);
        assert_eq!(
            resolved.runner_path,
            codex_profile_sessions_root(account_id)
                .join("2026")
                .join("09")
                .join("03")
                .join(format!("rollout-2026-09-03T00-00-00-{native_id}.jsonl"))
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn synchronize_materializes_unbound_then_preserves_existing_cli_transcript() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-native-sync-fresh";
        let account_id = "anthropic-native-sync-test";
        create_native_claude_session(session_id, account_id, sandbox.path());
        let complete_items = vec![
            message("user-1", "user", "Inspect the repository"),
            NativeConversationItem::ToolCall {
                id: "tool-call-1".to_string(),
                call_id: "call_1".to_string(),
                name: "read_file".to_string(),
                arguments: r#"{"path":"README.md"}"#.to_string(),
                created_at: "2026-09-02T00:00:01Z".to_string(),
            },
            NativeConversationItem::ToolResult {
                id: "tool-result-1".to_string(),
                call_id: "call_1".to_string(),
                name: "read_file".to_string(),
                output: "repository read".to_string(),
                is_error: false,
                interrupted: false,
                created_at: "2026-09-02T00:00:02Z".to_string(),
            },
            message("assistant-1", "assistant", "Inspection complete"),
        ];

        let receipt = synchronize_native_conversation_with_owner(
            None,
            session_id.to_string(),
            complete_items.clone(),
        )
        .await
        .expect("first synchronization should materialize the unbound episode");

        assert_eq!(receipt.item_count, complete_items.len());
        assert_eq!(
            persistence::get_cli_session_id_for_account(session_id, Some(account_id))
                .expect("read native binding")
                .as_deref(),
            Some(receipt.native_session_id.as_str())
        );
        let authoritative =
            authoritative_native_items(session_id).expect("round-trip native transcript");
        assert_eq!(authoritative.len(), complete_items.len());
        assert!(authoritative
            .iter()
            .zip(&complete_items)
            .all(|(native, canonical)| native_item_semantically_equal(native, canonical)));

        let session = persistence::get_session(session_id)
            .expect("load materialized CLI episode")
            .expect("materialized CLI episode exists");
        let cwd = execution_cwd(&session).expect("resolve materialized episode cwd");
        let paths = claude_native_paths(Some(account_id), &cwd, &receipt.native_session_id);
        let transcript_before = fs::read(&paths.native_path).expect("read materialized transcript");
        assert_eq!(
            fs::read(&paths.runner_path).expect("read runner transcript alias"),
            transcript_before
        );
        assert!(paths_match(&paths.native_path, &paths.runner_path));
        let project_index = fs::read_to_string(
            paths
                .native_path
                .parent()
                .expect("Claude project directory")
                .join("sessions-index.json"),
        )
        .expect("read Claude project index");
        assert!(project_index.contains(&receipt.native_session_id));

        let second_receipt = synchronize_native_conversation_with_owner(
            None,
            session_id.to_string(),
            complete_items.clone(),
        )
        .await
        .expect("an existing complete native transcript is already synchronized");

        assert_eq!(second_receipt.native_session_id, receipt.native_session_id);
        assert_eq!(second_receipt.item_count, complete_items.len());
        assert_eq!(
            fs::read(&paths.native_path).expect("read synchronized transcript"),
            transcript_before,
            "synchronizing an existing complete transcript must not rewrite provider-native state"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn synchronize_repairs_a_bound_but_unpublished_claude_intent() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-native-sync-repair-intent";
        let account_id = "anthropic-native-repair-test";
        create_native_claude_session(session_id, account_id, sandbox.path());
        let abandoned_id = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), abandoned_id)
            .expect("record incomplete materialization intent");

        let complete_items = vec![message("repair-user", "user", "continue safely")];
        let receipt = synchronize_native_conversation_with_owner(
            None,
            session_id.to_string(),
            complete_items,
        )
        .await
        .expect("repair incomplete intent");

        assert_ne!(receipt.native_session_id, abandoned_id);
        assert_eq!(
            persistence::get_cli_session_id_for_account(session_id, Some(account_id))
                .expect("read repaired binding")
                .as_deref(),
            Some(receipt.native_session_id.as_str())
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn synchronize_rebuilds_claude_binding_when_recorded_worktree_was_removed() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-native-sync-removed-worktree";
        let account_id = "anthropic-native-removed-worktree";
        let repo_path = sandbox.path().join("repo");
        let removed_worktree = sandbox.path().join("removed-worktree");
        fs::create_dir_all(&repo_path).expect("create fallback repository");
        create_native_claude_session(session_id, account_id, &repo_path);
        persistence::update_worktree_info(
            session_id,
            removed_worktree
                .to_str()
                .expect("removed worktree path is utf-8"),
            "agent/removed-worktree",
            "develop",
        )
        .expect("record removed worktree");

        let stale_native_id = "03b9bc8b-1111-4222-8333-bbbbbbbbbbbb";
        let complete_items = vec![
            message("user-1", "user", "Inspect the repository"),
            tool_call("call_1", "read_file", r#"{"path":"README.md"}"#),
            tool_result("call_1", "read_file", "repository read", false, false),
            message("assistant-1", "assistant", "Inspection complete"),
        ];
        let stale_paths = claude_native_paths(Some(account_id), &removed_worktree, stale_native_id);
        write_native_store_jsonl(
            &stale_paths,
            &claude_records_with_resume_checkpoint(
                stale_native_id,
                &removed_worktree,
                &complete_items,
            )
            .expect("render stale-worktree transcript"),
        )
        .expect("publish stale-worktree transcript");
        persistence::update_cli_session_id_for_account(
            session_id,
            Some(account_id),
            stale_native_id,
        )
        .expect("record stale-worktree binding");

        let receipt = synchronize_native_conversation_with_owner(
            None,
            session_id.to_string(),
            complete_items.clone(),
        )
        .await
        .expect("rebuild under the runner's fallback cwd");

        assert_ne!(receipt.native_session_id, stale_native_id);
        assert_eq!(receipt.item_count, complete_items.len());
        assert_eq!(
            persistence::get_cli_session_id_for_account(session_id, Some(account_id))
                .expect("read repaired binding")
                .as_deref(),
            Some(receipt.native_session_id.as_str())
        );
        let repaired_paths = claude_native_paths(
            Some(account_id),
            &provider_canonical_cwd(repo_path),
            &receipt.native_session_id,
        );
        assert!(repaired_paths.native_path.is_file());
        assert!(repaired_paths.runner_path.is_file());
        let authoritative =
            authoritative_native_items(session_id).expect("round-trip rebuilt transcript");
        assert_eq!(authoritative.len(), complete_items.len());
        assert!(authoritative
            .iter()
            .zip(&complete_items)
            .all(|(native, canonical)| native_item_semantically_equal(native, canonical)));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn synchronize_leaves_an_empty_cli_episode_unbound() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-native-sync-empty";
        let account_id = "anthropic-native-sync-empty-test";
        create_native_claude_session(session_id, account_id, sandbox.path());

        let receipt =
            synchronize_native_conversation_with_owner(None, session_id.to_string(), Vec::new())
                .await
                .expect("an empty canonical prefix is already synchronized");

        assert_eq!(receipt.item_count, 0);
        assert!(receipt.native_session_id.is_empty());
        assert_eq!(
            persistence::get_cli_session_id_for_account(session_id, Some(account_id))
                .expect("read native binding"),
            None
        );
        assert!(!app_paths::claude_code_cli_profile_dir(account_id)
            .join("projects")
            .exists());
    }

    #[test]
    fn failed_catalog_refresh_keeps_its_durable_receipt_pending() {
        let sandbox = test_env::sandbox();
        let session_id = "cliagent-native-catalog-failure";
        let account_id = "anthropic-native-catalog-failure";
        let native_id = "eeeeeeee-1111-4222-8333-ffffffffffff";
        create_native_claude_session(session_id, account_id, sandbox.path());
        persistence::update_cli_session_id_for_account(session_id, Some(account_id), native_id)
            .expect("publish provider UUID");
        let receipt =
            persistence::request_native_catalog_refresh(session_id, Some(account_id), native_id)
                .expect("request catalog refresh")
                .expect("binding exists");
        let native_path = sandbox
            .path()
            .join("native")
            .join(format!("{native_id}.jsonl"));
        let runner_path = sandbox
            .path()
            .join("runner")
            .join(format!("{native_id}.jsonl"));
        fs::create_dir_all(native_path.parent().expect("native parent"))
            .expect("create native parent");
        fs::create_dir_all(runner_path.parent().expect("runner parent"))
            .expect("create runner parent");
        fs::write(&native_path, b"{}\n").expect("write native transcript");
        fs::write(&runner_path, b"{}\n").expect("write runner transcript");
        fs::write(
            runner_path
                .parent()
                .expect("runner parent")
                .join("sessions-index.json"),
            b"not valid json",
        )
        .expect("write invalid provider index");

        let error = refresh_bound_native_catalog(BoundNativeCatalogRefresh::Claude {
            receipt: receipt.clone(),
            session_id: session_id.to_string(),
            cwd: sandbox.path().to_path_buf(),
            native_id: native_id.to_string(),
            native_path,
            runner_path,
            branch: None,
        })
        .expect_err("invalid provider index must fail refresh");
        assert!(error.contains("Claude"), "unexpected error: {error}");
        assert_eq!(
            persistence::pending_native_catalog_refreshes(8).expect("load pending receipt")[0]
                .receipt,
            receipt,
            "a failed refresh must remain durable for startup retry"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn startup_catalog_repair_is_pending_only_and_idempotent() {
        let sandbox = test_env::sandbox();
        let dirty_session_id = "cliagent-native-catalog-startup-dirty";
        let clean_session_id = "cliagent-native-catalog-startup-clean";
        let dirty_account_id = "anthropic-native-catalog-startup-dirty";
        let clean_account_id = "anthropic-native-catalog-startup-clean";
        let items = vec![message("startup-user", "user", "repair native catalog")];

        for (session_id, account_id) in [
            (dirty_session_id, dirty_account_id),
            (clean_session_id, clean_account_id),
        ] {
            create_native_claude_session(session_id, account_id, sandbox.path());
            synchronize_native_conversation_with_owner(None, session_id.to_string(), items.clone())
                .await
                .expect("materialize startup fixture");
        }
        let dirty_native_id =
            persistence::get_cli_session_id_for_account(dirty_session_id, Some(dirty_account_id))
                .expect("load dirty native binding")
                .expect("dirty native binding exists");
        persistence::request_native_catalog_refresh(
            dirty_session_id,
            Some(dirty_account_id),
            &dirty_native_id,
        )
        .expect("request startup repair")
        .expect("dirty binding exists");

        assert_eq!(
            reconcile_pending_native_catalog_refreshes_on_startup().await,
            (1, 0),
            "startup visits only the dirty receipt"
        );
        assert!(persistence::pending_native_catalog_refreshes(8)
            .expect("load pending after repair")
            .is_empty());
        assert_eq!(
            reconcile_pending_native_catalog_refreshes_on_startup().await,
            (0, 0),
            "a completed startup repair is idempotent"
        );
    }
}
