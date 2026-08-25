//! Read-only snapshots of managed Codex and Claude Code native transcripts.
//!
//! This module intentionally has no API that accepts a caller-provided path.
//! The public resolver starts from a managed `code_sessions` row, verifies the
//! requested runtime and account against that row, resolves the account profile
//! with `app_paths`, and only then locates the bound native transcript beneath
//! that one profile. It does not materialize, migrate, or modify native stores.

use std::fs::{self, File, Metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use key_vault::key_store::ModelType;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::native_transcript::TRANSCRIPT_SOURCE_NATIVE;
use super::persistence;
use super::types::{KeySource, SessionStatus};

/// Snapshot contract understood by this build. A later reader must reject an
/// unknown value instead of guessing at fields or native transcript semantics.
pub const NATIVE_SOURCE_SNAPSHOT_VERSION: u32 = 1;

/// Portability snapshots are explicit, bounded operations. Native histories
/// above this limit remain readable through the existing lazy history readers,
/// but are not eligible for an eager portability snapshot.
pub const MAX_NATIVE_SOURCE_SNAPSHOT_BYTES: u64 = 64 * 1024 * 1024;

const MAX_PROFILE_SCAN_ENTRIES: usize = 50_000;
const MAX_PROFILE_SCAN_DEPTH: usize = 12;
const FORMAT_PROBE_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSessionRuntime {
    ClaudeCode,
    Codex,
}

impl NativeSessionRuntime {
    fn cli_agent_type(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code",
            Self::Codex => "codex",
        }
    }

    fn model_type(self) -> ModelType {
        match self {
            Self::ClaudeCode => ModelType::ClaudeCode,
            Self::Codex => ModelType::Codex,
        }
    }

    fn account_profile_dir(self, account_id: &str) -> PathBuf {
        match self {
            Self::ClaudeCode => app_paths::claude_code_cli_profile_dir(account_id),
            Self::Codex => app_paths::codex_cli_profile_dir(account_id),
        }
    }

    fn transcript_root_suffix(self) -> &'static str {
        match self {
            Self::ClaudeCode => "projects",
            Self::Codex => "sessions",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeTranscriptFormat {
    ClaudeJsonl,
    CodexRolloutJsonl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeCompatibilityKind {
    SameProfileNativeResume,
    PortableCheckpointRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeCompatibilityReason {
    SameRuntimeSameAccountNativeStore,
    CrossRuntimeRequiresPortableCheckpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeSnapshotWarning {
    SourceCliVersionMissing,
    SourceCliVersionUnparseable,
}

/// A handle is derived from persisted session/account state. Its fields are
/// crate-visible for the next portability layer, but external callers cannot
/// construct one with an arbitrary profile path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSessionHandle {
    pub(crate) managed_session_id: String,
    pub(crate) runtime: NativeSessionRuntime,
    pub(crate) native_session_id: String,
    pub(crate) account_id: String,
    pub(crate) profile_path: PathBuf,
    pub(crate) captured_session_status: SessionStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub snapshot_version: u32,
    pub handle: NativeSessionHandle,
    pub source_path: PathBuf,
    pub source_format: NativeTranscriptFormat,
    pub source_format_version: u32,
    /// Provider CLI version recorded by the source transcript. This is
    /// distinct from `source_format_version`, which versions ORGII's parser
    /// contract rather than the external CLI binary.
    pub source_cli_version: Option<String>,
    /// Syntactic signal only. This does not mean the CLI version was audited
    /// or is materialization-compatible; every materializer remains disabled.
    pub source_cli_version_parseable: bool,
    pub source_size_bytes: u64,
    pub source_mtime_ms: u64,
    /// SHA-256 of the exact source bytes read for this snapshot.
    pub source_hash: String,
    /// SHA-256 of the final non-empty JSONL record, excluding its `\n`.
    pub terminal_digest: String,
    /// Domain-separated digest over handle identity, format, metadata, source
    /// hash, and terminal digest. This is the stable checkpoint precondition.
    pub source_digest: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRuntimeCompatibility {
    pub target_runtime: NativeSessionRuntime,
    pub kind: NativeCompatibilityKind,
    pub reason: NativeCompatibilityReason,
    /// Native resume is valid only inside the source handle's exact account
    /// profile. Same-runtime cross-account continuation still requires a
    /// validated checkpoint/materializer.
    pub requires_same_account: bool,
    /// This foundation is inventory-only. No native writer/materializer is
    /// exposed until a later layer can validate and atomically install one.
    pub materialization_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSnapshotCompatibilityInventory {
    pub snapshot: SourceSnapshot,
    pub targets: Vec<NativeRuntimeCompatibility>,
    pub warnings: Vec<NativeSnapshotWarning>,
}

/// Resolve and snapshot one managed native-transcript session.
///
/// `runtime` and `account_id` are expected-state guards, not lookup hints: both
/// must exactly match the persisted managed session. This prevents a stale UI
/// selection from reading another runtime or account profile.
pub async fn snapshot_inventory_for_managed_session(
    managed_session_id: &str,
    runtime: NativeSessionRuntime,
    account_id: &str,
) -> Result<NativeSnapshotCompatibilityInventory, String> {
    validate_identity_component("managed session id", managed_session_id)?;
    validate_identity_component("account id", account_id)?;

    let managed_session_id = managed_session_id.to_string();
    let account_id = account_id.to_string();
    let control_lock = super::session_runner::session_control_lock(&managed_session_id).await;
    let _control_guard = control_lock.lock().await;
    tokio::task::spawn_blocking(move || {
        snapshot_inventory_for_managed_session_blocking(&managed_session_id, runtime, &account_id)
    })
    .await
    .map_err(|err| format!("Native snapshot worker failed: {err}"))?
}

fn snapshot_inventory_for_managed_session_blocking(
    managed_session_id: &str,
    runtime: NativeSessionRuntime,
    account_id: &str,
) -> Result<NativeSnapshotCompatibilityInventory, String> {
    let session = persistence::get_session(managed_session_id)
        .map_err(|err| format!("Failed to load managed CLI session: {err}"))?
        .ok_or_else(|| format!("Managed CLI session not found: {managed_session_id}"))?;
    if session.transcript_source != TRANSCRIPT_SOURCE_NATIVE {
        return Err("Managed CLI session does not use a native transcript".to_string());
    }
    if session.key_source != KeySource::OwnKey {
        return Err(
            "Native portability snapshots currently require an account-scoped own-key profile"
                .to_string(),
        );
    }
    validate_quiescent_session(session.status, session.pid)?;

    let persisted_runtime = session
        .cli_agent_type
        .as_deref()
        .ok_or_else(|| "Managed CLI session is missing its runtime".to_string())?;
    if persisted_runtime != runtime.cli_agent_type() {
        return Err(format!(
            "Managed CLI runtime mismatch: expected {}, found {persisted_runtime}",
            runtime.cli_agent_type()
        ));
    }
    if ModelType::from_str(persisted_runtime).as_ref() != Some(&runtime.model_type()) {
        return Err(format!(
            "Managed CLI runtime is not snapshot-compatible: {persisted_runtime}"
        ));
    }

    let persisted_account = session
        .account_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Managed CLI session is missing its account".to_string())?;
    if persisted_account != account_id {
        return Err("Managed CLI account mismatch".to_string());
    }

    let native_session_id =
        persistence::get_cli_session_id_for_account(managed_session_id, Some(account_id))
            .map_err(|err| format!("Failed to load account-scoped native session id: {err}"))?
            .ok_or_else(|| "Managed CLI session has no native id for this account".to_string())?;
    validate_identity_component("native session id", &native_session_id)?;

    let handle = NativeSessionHandle {
        managed_session_id: managed_session_id.to_string(),
        runtime,
        native_session_id,
        account_id: account_id.to_string(),
        profile_path: runtime.account_profile_dir(account_id),
        captured_session_status: session.status,
    };
    let inventory = snapshot_inventory_for_handle(handle)?;

    // Re-read every routing/lifecycle dimension while the control lock is
    // still held. File-level before/after metadata catches source mutation;
    // this catches a stale DB/profile binding around the filesystem read.
    let current = persistence::get_session(managed_session_id)
        .map_err(|err| format!("Failed to revalidate managed CLI session: {err}"))?
        .ok_or_else(|| "Managed CLI session disappeared during snapshot".to_string())?;
    validate_quiescent_session(current.status, current.pid)?;
    if current.status != inventory.snapshot.handle.captured_session_status
        || current.cli_agent_type.as_deref() != Some(runtime.cli_agent_type())
        || current.account_id.as_deref() != Some(account_id)
        || current.transcript_source != TRANSCRIPT_SOURCE_NATIVE
        || current.key_source != KeySource::OwnKey
    {
        return Err("Managed CLI session changed during snapshot".to_string());
    }
    let current_native_id =
        persistence::get_cli_session_id_for_account(managed_session_id, Some(account_id))
            .map_err(|err| format!("Failed to revalidate native session id: {err}"))?;
    if current_native_id.as_deref() != Some(inventory.snapshot.handle.native_session_id.as_str()) {
        return Err("Managed CLI native binding changed during snapshot".to_string());
    }
    Ok(inventory)
}

fn validate_quiescent_session(status: SessionStatus, pid: Option<i64>) -> Result<(), String> {
    if matches!(status, SessionStatus::Pending | SessionStatus::Running) {
        return Err(format!(
            "Managed CLI session is not quiescent: status={status}"
        ));
    }
    if pid.is_some() {
        return Err("Managed CLI session is not quiescent: process is still active".to_string());
    }
    Ok(())
}

fn snapshot_inventory_for_handle(
    handle: NativeSessionHandle,
) -> Result<NativeSnapshotCompatibilityInventory, String> {
    let source_path = locate_source_in_profile(&handle)?;
    let snapshot = snapshot_source(&handle, &source_path)?;
    let warnings = match snapshot.source_cli_version.as_deref() {
        None => vec![NativeSnapshotWarning::SourceCliVersionMissing],
        Some(_) if !snapshot.source_cli_version_parseable => {
            vec![NativeSnapshotWarning::SourceCliVersionUnparseable]
        }
        Some(_) => Vec::new(),
    };
    let targets = [
        NativeSessionRuntime::ClaudeCode,
        NativeSessionRuntime::Codex,
    ]
    .into_iter()
    .map(|target_runtime| NativeRuntimeCompatibility {
        target_runtime,
        kind: if target_runtime == handle.runtime {
            NativeCompatibilityKind::SameProfileNativeResume
        } else {
            NativeCompatibilityKind::PortableCheckpointRequired
        },
        reason: if target_runtime == handle.runtime {
            NativeCompatibilityReason::SameRuntimeSameAccountNativeStore
        } else {
            NativeCompatibilityReason::CrossRuntimeRequiresPortableCheckpoint
        },
        requires_same_account: target_runtime == handle.runtime,
        materialization_available: false,
    })
    .collect();
    Ok(NativeSnapshotCompatibilityInventory {
        snapshot,
        targets,
        warnings,
    })
}

fn locate_source_in_profile(handle: &NativeSessionHandle) -> Result<PathBuf, String> {
    validate_identity_component("native session id", &handle.native_session_id)?;
    let profile = handle
        .profile_path
        .canonicalize()
        .map_err(|err| format!("Native profile is unavailable: {err}"))?;
    if !profile.is_dir() {
        return Err("Native profile is not a directory".to_string());
    }
    let transcript_root = profile.join(handle.runtime.transcript_root_suffix());
    if !transcript_root.is_dir() {
        return Err(format!(
            "Native {} transcript directory is unavailable",
            handle.runtime.cli_agent_type()
        ));
    }

    let mut candidates = Vec::new();
    let mut visited = 0usize;
    collect_profile_candidates(
        handle.runtime,
        &handle.native_session_id,
        &transcript_root,
        0,
        &mut visited,
        &mut candidates,
    )?;
    if candidates.is_empty() {
        return Err(format!(
            "Native transcript not found for session {}",
            handle.native_session_id
        ));
    }

    let candidate = match handle.runtime {
        NativeSessionRuntime::ClaudeCode => {
            if candidates.len() != 1 {
                return Err(format!(
                    "Ambiguous Claude native transcript for session {}",
                    handle.native_session_id
                ));
            }
            candidates.pop().expect("one checked candidate")
        }
        NativeSessionRuntime::Codex => candidates
            .into_iter()
            .max_by(|left, right| candidate_recency(left).cmp(&candidate_recency(right)))
            .expect("non-empty candidates"),
    };

    let canonical = candidate
        .canonicalize()
        .map_err(|err| format!("Failed to resolve native transcript: {err}"))?;
    if !canonical.starts_with(&profile) || !canonical.is_file() {
        return Err("Native transcript escaped its account profile".to_string());
    }
    Ok(canonical)
}

fn collect_profile_candidates(
    runtime: NativeSessionRuntime,
    native_session_id: &str,
    directory: &Path,
    depth: usize,
    visited: &mut usize,
    candidates: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_PROFILE_SCAN_DEPTH {
        return Err("Native profile scan exceeded its depth limit".to_string());
    }
    let entries = fs::read_dir(directory)
        .map_err(|err| format!("Failed to read native transcript directory: {err}"))?;
    for entry in entries {
        *visited = visited.saturating_add(1);
        if *visited > MAX_PROFILE_SCAN_ENTRIES {
            return Err("Native profile scan exceeded its entry limit".to_string());
        }
        let entry = entry.map_err(|err| format!("Failed to read native profile entry: {err}"))?;
        let file_type = entry
            .file_type()
            .map_err(|err| format!("Failed to inspect native profile entry: {err}"))?;
        // Never follow symlinks during discovery. Canonical containment below
        // is a second line of defense against a path swap after enumeration.
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_profile_candidates(
                runtime,
                native_session_id,
                &path,
                depth + 1,
                visited,
                candidates,
            )?;
            continue;
        }
        if !file_type.is_file()
            || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
        {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let matches = match runtime {
            NativeSessionRuntime::ClaudeCode => stem == native_session_id,
            NativeSessionRuntime::Codex => {
                stem == native_session_id
                    || (stem.len() > native_session_id.len() + 1
                        && stem.ends_with(native_session_id)
                        && stem.as_bytes()[stem.len() - native_session_id.len() - 1] == b'-')
            }
        };
        if matches {
            candidates.push(path);
        }
    }
    Ok(())
}

fn candidate_recency(path: &Path) -> (u128, PathBuf) {
    let modified = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    (modified, path.to_path_buf())
}

fn snapshot_source(
    handle: &NativeSessionHandle,
    source_path: &Path,
) -> Result<SourceSnapshot, String> {
    snapshot_source_with_observer(handle, source_path, |_| {})
}

fn snapshot_source_with_observer<F>(
    handle: &NativeSessionHandle,
    source_path: &Path,
    after_read: F,
) -> Result<SourceSnapshot, String>
where
    F: FnOnce(&Path),
{
    let profile = handle
        .profile_path
        .canonicalize()
        .map_err(|err| format!("Native profile is unavailable: {err}"))?;
    let canonical_before = source_path
        .canonicalize()
        .map_err(|err| format!("Failed to resolve native transcript: {err}"))?;
    if !canonical_before.starts_with(&profile) {
        return Err("Native transcript escaped its account profile".to_string());
    }

    let mut file = File::open(&canonical_before)
        .map_err(|err| format!("Failed to open native transcript: {err}"))?;
    let metadata_before = file
        .metadata()
        .map_err(|err| format!("Failed to stat native transcript: {err}"))?;
    validate_source_metadata(&metadata_before)?;
    let source_size_bytes = metadata_before.len();
    let source_mtime_ms = modified_ms(&metadata_before)?;

    let HashedSource {
        source_hash,
        terminal_digest,
        format_probe,
    } = hash_bounded_source(&mut file, source_size_bytes)?;
    let detected = detect_source_format(
        handle.runtime,
        &handle.native_session_id,
        &format_probe,
        source_size_bytes <= FORMAT_PROBE_BYTES as u64,
    )?;
    let source_cli_version_parseable = detected
        .source_cli_version
        .as_deref()
        .is_some_and(is_semver_like);

    after_read(&canonical_before);

    // A second bounded pass closes the same-size/coarse-mtime rewrite gap on
    // platforms whose `Metadata` lacks a stable inode/change-time identity.
    // Snapshotting is explicit and capped at 64 MiB; there is no idle or
    // background I/O path.
    let verified = hash_bounded_source(&mut file, source_size_bytes)
        .map_err(|err| format!("Native transcript changed during snapshot: {err}"))?;
    if verified.source_hash != source_hash || verified.terminal_digest != terminal_digest {
        return Err("Native transcript changed during snapshot".to_string());
    }

    let metadata_after = file
        .metadata()
        .map_err(|err| format!("Failed to restat native transcript: {err}"))?;
    let canonical_after = source_path
        .canonicalize()
        .map_err(|err| format!("Native transcript changed during snapshot: {err}"))?;
    let path_metadata_after = fs::metadata(&canonical_after)
        .map_err(|err| format!("Failed to restat native transcript path: {err}"))?;
    if canonical_after != canonical_before
        || !canonical_after.starts_with(&profile)
        || !same_source_identity(&metadata_before, &metadata_after)
        || !same_source_identity(&metadata_before, &path_metadata_after)
    {
        return Err("Native transcript changed during snapshot".to_string());
    }

    let source_digest = snapshot_digest(
        handle,
        detected.source_format,
        detected.source_format_version,
        detected.source_cli_version.as_deref(),
        source_cli_version_parseable,
        source_size_bytes,
        source_mtime_ms,
        &source_hash,
        &terminal_digest,
    );
    Ok(SourceSnapshot {
        snapshot_version: NATIVE_SOURCE_SNAPSHOT_VERSION,
        handle: handle.clone(),
        source_path: canonical_before,
        source_format: detected.source_format,
        source_format_version: detected.source_format_version,
        source_cli_version: detected.source_cli_version,
        source_cli_version_parseable,
        source_size_bytes,
        source_mtime_ms,
        source_hash,
        terminal_digest,
        source_digest,
    })
}

fn validate_source_metadata(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_file() {
        return Err("Native transcript is not a regular file".to_string());
    }
    if metadata.len() == 0 {
        return Err("Native transcript is empty".to_string());
    }
    if metadata.len() > MAX_NATIVE_SOURCE_SNAPSHOT_BYTES {
        return Err(format!(
            "Native transcript exceeds the {} byte snapshot limit",
            MAX_NATIVE_SOURCE_SNAPSHOT_BYTES
        ));
    }
    Ok(())
}

struct HashedSource {
    source_hash: String,
    terminal_digest: String,
    format_probe: Vec<u8>,
}

fn hash_bounded_source(file: &mut File, expected_len: u64) -> Result<HashedSource, String> {
    file.seek(SeekFrom::Start(0))
        .map_err(|err| format!("Failed to seek native transcript: {err}"))?;
    let mut source_hasher = Sha256::new();
    let mut current_line_hasher = Sha256::new();
    let mut current_line_non_whitespace = false;
    let mut terminal_digest = None;
    let mut format_probe = Vec::with_capacity(FORMAT_PROBE_BYTES.min(expected_len as usize));
    let mut remaining = expected_len;
    let mut buffer = [0u8; 64 * 1024];

    while remaining > 0 {
        let wanted = usize::try_from(remaining.min(buffer.len() as u64)).unwrap_or(buffer.len());
        let count = file
            .read(&mut buffer[..wanted])
            .map_err(|err| format!("Failed to read native transcript: {err}"))?;
        if count == 0 {
            return Err("Native transcript was truncated during snapshot".to_string());
        }
        let bytes = &buffer[..count];
        source_hasher.update(bytes);
        if format_probe.len() < FORMAT_PROBE_BYTES {
            let take = (FORMAT_PROBE_BYTES - format_probe.len()).min(bytes.len());
            format_probe.extend_from_slice(&bytes[..take]);
        }
        for segment in bytes.split_inclusive(|byte| *byte == b'\n') {
            let (body, ended) = segment
                .strip_suffix(b"\n")
                .map_or((segment, false), |body| (body, true));
            current_line_hasher.update(body);
            current_line_non_whitespace |= body.iter().any(|byte| !byte.is_ascii_whitespace());
            if ended {
                if current_line_non_whitespace {
                    terminal_digest = Some(tagged_hash(current_line_hasher.finalize_reset()));
                } else {
                    current_line_hasher.reset();
                }
                current_line_non_whitespace = false;
            }
        }
        remaining -= count as u64;
    }
    if current_line_non_whitespace {
        terminal_digest = Some(tagged_hash(current_line_hasher.finalize()));
    }
    let terminal_digest =
        terminal_digest.ok_or_else(|| "Native transcript has no complete record".to_string())?;
    Ok(HashedSource {
        source_hash: tagged_hash(source_hasher.finalize()),
        terminal_digest,
        format_probe,
    })
}

struct DetectedSourceFormat {
    source_format: NativeTranscriptFormat,
    source_format_version: u32,
    source_cli_version: Option<String>,
}

fn detect_source_format(
    runtime: NativeSessionRuntime,
    native_session_id: &str,
    probe: &[u8],
    probe_contains_eof: bool,
) -> Result<DetectedSourceFormat, String> {
    let mut parsed_records = Vec::new();
    let mut lines = probe.split(|byte| *byte == b'\n').peekable();
    while let Some(line) = lines.next() {
        if line.iter().all(|byte| byte.is_ascii_whitespace()) {
            continue;
        }
        let is_complete = lines.peek().is_some() || probe_contains_eof;
        if !is_complete {
            break;
        }
        let value = serde_json::from_slice::<serde_json::Value>(line)
            .map_err(|_| "Unknown native transcript format version".to_string())?;
        parsed_records.push(value);
        if parsed_records.len() >= 32 {
            break;
        }
    }
    let first = parsed_records
        .first()
        .ok_or_else(|| "Unknown native transcript format version".to_string())?;

    match runtime {
        NativeSessionRuntime::Codex => {
            if first.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
                return Err("Unknown Codex transcript format version".to_string());
            }
            let primary_id = first
                .pointer("/payload/id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let legacy_id = first
                .pointer("/payload/session_id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            if primary_id.is_some() && legacy_id.is_some() && primary_id != legacy_id {
                return Err("Codex transcript metadata contains conflicting native ids".to_string());
            }
            let source_id = primary_id
                .or(legacy_id)
                .ok_or_else(|| "Codex transcript metadata is missing its native id".to_string())?;
            if source_id != native_session_id {
                return Err("Codex transcript native id mismatch".to_string());
            }
            Ok(DetectedSourceFormat {
                source_format: NativeTranscriptFormat::CodexRolloutJsonl,
                source_format_version: 1,
                source_cli_version: first
                    .pointer("/payload/cli_version")
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
            })
        }
        NativeSessionRuntime::ClaudeCode => {
            let first_type = first
                .get("type")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            if !matches!(
                first_type,
                "summary" | "ai-title" | "custom-title" | "user" | "assistant" | "system"
            ) {
                return Err("Unknown Claude transcript format version".to_string());
            }
            let source_id = parsed_records
                .iter()
                .filter_map(|record| {
                    record
                        .get("sessionId")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                })
                .next()
                .ok_or_else(|| "Claude transcript metadata is missing its native id".to_string())?;
            if source_id != native_session_id {
                return Err("Claude transcript native id mismatch".to_string());
            }
            Ok(DetectedSourceFormat {
                source_format: NativeTranscriptFormat::ClaudeJsonl,
                source_format_version: 1,
                source_cli_version: parsed_records.iter().find_map(|record| {
                    record
                        .get("version")
                        .and_then(serde_json::Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string)
                }),
            })
        }
    }
}

fn is_semver_like(value: &str) -> bool {
    let value = value.trim().strip_prefix('v').unwrap_or(value.trim());
    let core = value.split_once(['-', '+']).map_or(value, |(core, _)| core);
    let mut components = core.split('.');
    let valid_component = |component: &str| {
        !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
    };
    matches!(
        (components.next(), components.next(), components.next(), components.next()),
        (Some(major), Some(minor), Some(patch), None)
            if valid_component(major) && valid_component(minor) && valid_component(patch)
    )
}

fn modified_ms(metadata: &Metadata) -> Result<u64, String> {
    metadata
        .modified()
        .map_err(|err| format!("Failed to read native transcript mtime: {err}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Native transcript mtime is before the Unix epoch".to_string())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

fn same_source_identity(left: &Metadata, right: &Metadata) -> bool {
    if left.len() != right.len() || left.modified().ok() != right.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.ctime() == right.ctime()
            && left.ctime_nsec() == right.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[allow(clippy::too_many_arguments)]
fn snapshot_digest(
    handle: &NativeSessionHandle,
    source_format: NativeTranscriptFormat,
    source_format_version: u32,
    source_cli_version: Option<&str>,
    source_cli_version_parseable: bool,
    source_size_bytes: u64,
    source_mtime_ms: u64,
    source_hash: &str,
    terminal_digest: &str,
) -> String {
    let mut hasher = Sha256::new();
    hash_field(
        &mut hasher,
        "snapshot-version",
        &NATIVE_SOURCE_SNAPSHOT_VERSION.to_string(),
    );
    hash_field(&mut hasher, "managed-session", &handle.managed_session_id);
    hash_field(&mut hasher, "runtime", handle.runtime.cli_agent_type());
    hash_field(&mut hasher, "native-session", &handle.native_session_id);
    hash_field(&mut hasher, "account", &handle.account_id);
    hash_field(
        &mut hasher,
        "captured-status",
        handle.captured_session_status.as_ref(),
    );
    hash_field(&mut hasher, "format", &format!("{source_format:?}"));
    hash_field(
        &mut hasher,
        "format-version",
        &source_format_version.to_string(),
    );
    hash_field(
        &mut hasher,
        "source-cli-version",
        source_cli_version.unwrap_or_default(),
    );
    hash_field(
        &mut hasher,
        "source-cli-version-parseable",
        if source_cli_version_parseable {
            "true"
        } else {
            "false"
        },
    );
    hash_field(&mut hasher, "size", &source_size_bytes.to_string());
    hash_field(&mut hasher, "mtime-ms", &source_mtime_ms.to_string());
    hash_field(&mut hasher, "source-hash", source_hash);
    hash_field(&mut hasher, "terminal-digest", terminal_digest);
    tagged_hash(hasher.finalize())
}

fn hash_field(hasher: &mut Sha256, name: &str, value: &str) {
    hasher.update((name.len() as u64).to_le_bytes());
    hasher.update(name.as_bytes());
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value.as_bytes());
}

fn tagged_hash(hash: impl AsRef<[u8]>) -> String {
    let bytes = hash.as_ref();
    let mut encoded = String::with_capacity("sha256:".len() + bytes.len() * 2);
    encoded.push_str("sha256:");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(encoded, "{byte:02x}");
    }
    encoded
}

fn validate_identity_component(label: &str, value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'@' | b'.'))
        && value != "."
        && value != "..";
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid {label}"))
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::TempDir;

    use super::*;

    fn handle(
        runtime: NativeSessionRuntime,
        native_session_id: &str,
        profile_path: &Path,
    ) -> NativeSessionHandle {
        NativeSessionHandle {
            managed_session_id: "managed-session-1".to_string(),
            runtime,
            native_session_id: native_session_id.to_string(),
            account_id: "account-a".to_string(),
            profile_path: profile_path.to_path_buf(),
            captured_session_status: SessionStatus::Idle,
        }
    }

    fn write_claude(profile: &Path, native_id: &str, prompt: &str) -> PathBuf {
        let directory = profile.join("projects").join("project-a");
        fs::create_dir_all(&directory).expect("create Claude fixture root");
        let path = directory.join(format!("{native_id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{native_id}\",\"version\":\"2.1.3\",\"message\":{{\"role\":\"user\",\"content\":\"{prompt}\"}}}}\n"
            ),
        )
        .expect("write Claude fixture");
        path
    }

    fn write_codex(profile: &Path, native_id: &str, prompt: &str) -> PathBuf {
        let directory = profile.join("sessions").join("2026").join("08").join("25");
        fs::create_dir_all(&directory).expect("create Codex fixture root");
        let path = directory.join(format!("rollout-2026-08-25T01-02-03-{native_id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{native_id}\",\"cli_version\":\"0.42.1\"}}}}\n{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":\"{prompt}\"}}}}\n"
            ),
        )
        .expect("write Codex fixture");
        path
    }

    #[test]
    fn snapshots_claude_and_codex_with_stable_digests() {
        for (runtime, native_id) in [
            (NativeSessionRuntime::ClaudeCode, "claude-session-1"),
            (NativeSessionRuntime::Codex, "codex-session-1"),
        ] {
            let temp = TempDir::new().expect("temp profile");
            match runtime {
                NativeSessionRuntime::ClaudeCode => {
                    write_claude(temp.path(), native_id, "hello");
                }
                NativeSessionRuntime::Codex => {
                    write_codex(temp.path(), native_id, "hello");
                }
            }
            let first = snapshot_inventory_for_handle(handle(runtime, native_id, temp.path()))
                .expect("snapshot");
            let second = snapshot_inventory_for_handle(handle(runtime, native_id, temp.path()))
                .expect("repeat snapshot");
            assert_eq!(first.snapshot.source_hash, second.snapshot.source_hash);
            assert_eq!(
                first.snapshot.terminal_digest,
                second.snapshot.terminal_digest
            );
            assert_eq!(first.snapshot.source_digest, second.snapshot.source_digest);
            assert!(first.snapshot.source_cli_version_parseable);
            assert!(first.warnings.is_empty());
            assert_eq!(
                first.snapshot.handle.captured_session_status,
                SessionStatus::Idle
            );
            assert_eq!(first.targets.len(), 2);
            assert!(first
                .targets
                .iter()
                .all(|target| !target.materialization_available));
            assert_eq!(
                first
                    .targets
                    .iter()
                    .find(|target| target.target_runtime == runtime)
                    .map(|target| target.kind),
                Some(NativeCompatibilityKind::SameProfileNativeResume)
            );
            let same_runtime = first
                .targets
                .iter()
                .find(|target| target.target_runtime == runtime)
                .expect("same-runtime compatibility");
            assert!(same_runtime.requires_same_account);
            assert_eq!(
                same_runtime.reason,
                NativeCompatibilityReason::SameRuntimeSameAccountNativeStore
            );
            assert!(first
                .targets
                .iter()
                .filter(|target| target.target_runtime != runtime)
                .all(|target| !target.requires_same_account));
        }
    }

    #[test]
    fn digest_changes_when_the_source_changes() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "claude-session-1";
        let path = write_claude(temp.path(), native_id, "hello");
        let before = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            temp.path(),
        ))
        .expect("first snapshot");
        let mut file = fs::OpenOptions::new()
            .append(true)
            .open(path)
            .expect("open append");
        writeln!(
            file,
            "{{\"type\":\"assistant\",\"sessionId\":\"{native_id}\",\"message\":{{\"role\":\"assistant\",\"content\":[]}}}}"
        )
        .expect("append source");
        let after = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            temp.path(),
        ))
        .expect("second snapshot");
        assert_ne!(before.snapshot.source_hash, after.snapshot.source_hash);
        assert_ne!(
            before.snapshot.terminal_digest,
            after.snapshot.terminal_digest
        );
        assert_ne!(before.snapshot.source_digest, after.snapshot.source_digest);
    }

    #[test]
    fn rejects_source_mutation_during_snapshot() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "codex-session-1";
        let path = write_codex(temp.path(), native_id, "hello");
        let handle = handle(NativeSessionRuntime::Codex, native_id, temp.path());
        let err = snapshot_source_with_observer(&handle, &path, |path| {
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(path)
                .expect("open append");
            writeln!(file, "{{\"type\":\"future_event\"}}").expect("mutate source");
        })
        .expect_err("concurrent mutation must fail");
        assert!(err.contains("changed during snapshot"), "{err}");
    }

    #[test]
    fn rejects_same_size_source_rewrite_during_snapshot() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "codex-session-1";
        let path = write_codex(temp.path(), native_id, "hello");
        let handle = handle(NativeSessionRuntime::Codex, native_id, temp.path());
        let err = snapshot_source_with_observer(&handle, &path, |path| {
            let original = fs::read_to_string(path).expect("read fixture");
            let rewritten = original.replacen("hello", "jello", 1);
            assert_eq!(original.len(), rewritten.len());
            fs::write(path, rewritten).expect("rewrite source in place");
        })
        .expect_err("same-size concurrent rewrite must fail");
        assert!(err.contains("changed during snapshot"), "{err}");
    }

    #[test]
    fn profile_lookup_isolated_to_the_selected_account() {
        let account_a = TempDir::new().expect("account A");
        let account_b = TempDir::new().expect("account B");
        let native_id = "shared-native-id";
        let path_a = write_claude(account_a.path(), native_id, "from account A");
        write_claude(account_b.path(), native_id, "from account B");

        let snapshot = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            account_a.path(),
        ))
        .expect("account A snapshot");
        assert_eq!(
            snapshot.snapshot.source_path,
            path_a.canonicalize().expect("canonical account A path")
        );
        assert!(snapshot.snapshot.source_path.starts_with(
            account_a
                .path()
                .canonicalize()
                .expect("canonical account A")
        ));
        assert!(!snapshot.snapshot.source_path.starts_with(
            account_b
                .path()
                .canonicalize()
                .expect("canonical account B")
        ));
    }

    #[test]
    fn rejects_path_traversal_identity_before_scanning() {
        let temp = TempDir::new().expect("temp profile");
        fs::create_dir_all(temp.path().join("projects")).expect("projects root");
        let err = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            "../escaped",
            temp.path(),
        ))
        .expect_err("path traversal id must fail");
        assert_eq!(err, "Invalid native session id");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_a_transcript_symlink_outside_the_profile() {
        use std::os::unix::fs::symlink;

        let profile = TempDir::new().expect("profile");
        let outside = TempDir::new().expect("outside");
        let native_id = "claude-session-1";
        let outside_path = write_claude(outside.path(), native_id, "outside");
        let project = profile.path().join("projects").join("project-a");
        fs::create_dir_all(&project).expect("profile project");
        symlink(&outside_path, project.join(format!("{native_id}.jsonl")))
            .expect("create escape symlink");

        let err = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            profile.path(),
        ))
        .expect_err("symlink escape must fail");
        assert!(err.contains("not found"), "{err}");
    }

    #[test]
    fn rejects_sources_over_the_snapshot_size_limit_without_reading_them() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "codex-session-1";
        let path = write_codex(temp.path(), native_id, "hello");
        File::options()
            .write(true)
            .open(&path)
            .expect("open sparse fixture")
            .set_len(MAX_NATIVE_SOURCE_SNAPSHOT_BYTES + 1)
            .expect("extend sparse fixture");
        let err = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::Codex,
            native_id,
            temp.path(),
        ))
        .expect_err("oversized snapshot must fail");
        assert!(err.contains("snapshot limit"), "{err}");
    }

    #[test]
    fn unknown_native_format_version_fails_closed() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "codex-session-1";
        let directory = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("08")
            .join("25");
        fs::create_dir_all(&directory).expect("sessions root");
        fs::write(
            directory.join(format!("rollout-{native_id}.jsonl")),
            format!("{{\"type\":\"session_meta_v2\",\"payload\":{{\"id\":\"{native_id}\"}}}}\n"),
        )
        .expect("write future format");
        let err = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::Codex,
            native_id,
            temp.path(),
        ))
        .expect_err("unknown format must fail");
        assert_eq!(err, "Unknown Codex transcript format version");
    }

    #[test]
    fn claude_custom_title_first_record_captures_parseable_cli_version() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "claude-session-1";
        let directory = temp.path().join("projects").join("project-a");
        fs::create_dir_all(&directory).expect("projects root");
        fs::write(
            directory.join(format!("{native_id}.jsonl")),
            format!(
                "{{\"type\":\"custom-title\",\"customTitle\":\"My convo\",\"sessionId\":\"{native_id}\",\"version\":\"2.3.4\"}}\n{{\"type\":\"user\",\"sessionId\":\"{native_id}\",\"version\":\"2.3.4\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n"
            ),
        )
        .expect("write Claude metadata-first fixture");
        let inventory = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            temp.path(),
        ))
        .expect("metadata-first snapshot");
        assert_eq!(
            inventory.snapshot.source_cli_version.as_deref(),
            Some("2.3.4")
        );
        assert!(inventory.snapshot.source_cli_version_parseable);
        assert!(inventory.warnings.is_empty());
    }

    #[test]
    fn codex_session_id_fallback_and_unparseable_cli_version_are_inventory_only() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "codex-session-1";
        let directory = temp
            .path()
            .join("sessions")
            .join("2026")
            .join("08")
            .join("25");
        fs::create_dir_all(&directory).expect("sessions root");
        fs::write(
            directory.join(format!("rollout-{native_id}.jsonl")),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"session_id\":\"{native_id}\",\"cli_version\":\"future-build\"}}}}\n"
            ),
        )
        .expect("write Codex fallback fixture");
        let inventory = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::Codex,
            native_id,
            temp.path(),
        ))
        .expect("session_id fallback snapshot");
        assert_eq!(
            inventory.snapshot.source_cli_version.as_deref(),
            Some("future-build")
        );
        assert!(!inventory.snapshot.source_cli_version_parseable);
        assert_eq!(
            inventory.warnings,
            vec![NativeSnapshotWarning::SourceCliVersionUnparseable]
        );
        assert!(inventory
            .targets
            .iter()
            .all(|target| !target.materialization_available));
    }

    #[test]
    fn missing_cli_version_is_explicit_and_never_materializable() {
        let temp = TempDir::new().expect("temp profile");
        let native_id = "claude-session-1";
        let directory = temp.path().join("projects").join("project-a");
        fs::create_dir_all(&directory).expect("projects root");
        fs::write(
            directory.join(format!("{native_id}.jsonl")),
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{native_id}\",\"message\":{{\"role\":\"user\",\"content\":\"hello\"}}}}\n"
            ),
        )
        .expect("write versionless fixture");
        let inventory = snapshot_inventory_for_handle(handle(
            NativeSessionRuntime::ClaudeCode,
            native_id,
            temp.path(),
        ))
        .expect("versionless snapshot");
        assert_eq!(inventory.snapshot.source_cli_version, None);
        assert!(!inventory.snapshot.source_cli_version_parseable);
        assert_eq!(
            inventory.warnings,
            vec![NativeSnapshotWarning::SourceCliVersionMissing]
        );
        assert!(inventory
            .targets
            .iter()
            .all(|target| !target.materialization_available));
    }

    #[test]
    fn running_pending_or_live_pid_sessions_are_not_quiescent() {
        for status in [SessionStatus::Pending, SessionStatus::Running] {
            let err = validate_quiescent_session(status, None)
                .expect_err("active lifecycle must reject snapshots");
            assert!(err.contains("not quiescent"), "{err}");
        }
        let err = validate_quiescent_session(SessionStatus::Idle, Some(42))
            .expect_err("live process must reject snapshots");
        assert!(err.contains("process is still active"), "{err}");
        for status in [
            SessionStatus::Idle,
            SessionStatus::Completed,
            SessionStatus::Failed,
            SessionStatus::Cancelled,
        ] {
            validate_quiescent_session(status, None).expect("quiescent terminal policy");
        }
    }
}
