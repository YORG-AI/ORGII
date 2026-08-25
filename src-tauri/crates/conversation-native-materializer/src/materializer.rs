use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};

use crate::filesystem::{
    canonical_existing_directory, ensure_private_relative_directory, move_candidate_to_recovery,
    publish_private_no_clobber, read_identity_guarded, remove_if_identity_matches,
    require_supported_platform, same_file_identity, validate_executable,
};
use crate::native::{
    appended_first_user_turn, reparse_native, serialize_native, NativeFormatContext,
    MAX_NATIVE_TRANSCRIPT_BYTES,
};
use crate::semantic::portable_semantics;
use crate::{
    AcceptedNativeMaterialization, NativeConversationRuntime, NativeMaterializationCandidate,
    NativeMaterializationError, NativeMaterializationFailureKind, NativeMaterializationRequest,
    NativeMaterializationResult, NativeResumeObservation, NativeResumePlan, NativeRuntimeTarget,
    RejectedNativeMaterialization, CLAUDE_CODE_SUPPORTED_VERSIONS, CODEX_SUPPORTED_VERSIONS,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparationFault {
    None,
    #[cfg(test)]
    CorruptAfterPublish,
}

pub fn prepare_native_materialization(
    request: NativeMaterializationRequest<'_>,
) -> NativeMaterializationResult<NativeMaterializationCandidate> {
    prepare_native_materialization_inner(request, PreparationFault::None)
}

fn prepare_native_materialization_inner(
    request: NativeMaterializationRequest<'_>,
    fault: PreparationFault,
) -> NativeMaterializationResult<NativeMaterializationCandidate> {
    #[cfg(not(test))]
    let _ = fault;
    require_supported_platform()?;
    validate_request_strings(&request)?;
    validate_version(request.runtime.runtime(), request.observed_cli_version)?;
    let created_at = DateTime::parse_from_rfc3339(request.created_at).map_err(|error| {
        NativeMaterializationError::invalid(format!(
            "Materialization created_at must be RFC3339: {error}"
        ))
    })?;
    let target_profile_root =
        canonical_existing_directory("target profile root", request.target_profile_root)?;
    let target_workspace_root =
        canonical_existing_directory("target workspace root", request.target_workspace_root)?;
    let recovery_root = canonical_existing_directory("recovery root", request.recovery_root)?;
    let profile_value = target_profile_root
        .to_str()
        .ok_or_else(|| {
            NativeMaterializationError::invalid("Target profile root is not valid UTF-8")
        })?
        .to_string();
    if recovery_root.starts_with(&target_profile_root)
        || target_profile_root.starts_with(&recovery_root)
    {
        return Err(NativeMaterializationError::invalid(
            "Recovery root and provider profile root must be disjoint",
        ));
    }
    ensure_private_relative_directory(&recovery_root, Path::new(""))?;
    let executable = validate_executable(request.cli_executable)?;
    let target_session_id = request.target_session_id.to_string();
    reject_reused_source_identity(
        &request.conversation.source.source_session_id,
        &target_session_id,
    )?;

    let semantics = portable_semantics(request.conversation)?;
    let encoded_portable = request
        .conversation
        .encode_canonical()
        .map_err(NativeMaterializationError::invalid)?;
    let (target_directory, filename) = target_location(
        request.runtime.runtime(),
        &target_profile_root,
        &target_workspace_root,
        &target_session_id,
        created_at.with_timezone(&Utc),
    )?;
    let target_path = target_directory.join(filename);
    reject_same_source_path(request.source_native_path, &target_path)?;

    let format_context = NativeFormatContext {
        session_id: &target_session_id,
        workspace: &target_workspace_root,
        cli_version: request.observed_cli_version,
        target: &request.runtime,
        created_at: request.created_at,
    };
    let native_bytes = serialize_native(&format_context, &semantics)?;
    let independently_parsed =
        reparse_native(request.runtime.runtime(), &native_bytes, &format_context)?;
    require_semantic_parity(
        &semantics,
        &independently_parsed,
        "staged native transcript",
    )?;

    let published_identity =
        publish_private_no_clobber(&target_profile_root, &target_path, &native_bytes)?;
    let post_publish = (|| -> NativeMaterializationResult<(String, u64)> {
        #[cfg(test)]
        if fault == PreparationFault::CorruptAfterPublish {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&target_path)
                .map_err(|error| NativeMaterializationError::filesystem(error.to_string()))?;
            file.write_all(b"not-json\n")
                .and_then(|()| file.sync_all())
                .map_err(|error| NativeMaterializationError::filesystem(error.to_string()))?;
        }
        let (published_bytes, observed_identity) =
            read_identity_guarded(&target_path, MAX_NATIVE_TRANSCRIPT_BYTES)?;
        if !same_file_identity(&published_identity, &observed_identity) {
            return Err(NativeMaterializationError::filesystem(
                "Native transcript identity changed during publication verification",
            ));
        }
        if published_bytes != native_bytes {
            return Err(NativeMaterializationError::parity(
                "Published native transcript bytes differ from the verified staging bytes",
            ));
        }
        let reparsed =
            reparse_native(request.runtime.runtime(), &published_bytes, &format_context)?;
        require_semantic_parity(&semantics, &reparsed, "published native transcript")?;
        Ok((sha256_hex(&published_bytes), observed_identity.bytes))
    })();
    let (native_sha256, native_bytes_count) = match post_publish {
        Ok(result) => result,
        Err(error) => {
            if let Err(cleanup_error) =
                remove_if_identity_matches(&target_path, &published_identity)
            {
                return Err(NativeMaterializationError::filesystem(format!(
                    "{error}; cleanup also failed: {cleanup_error}"
                )));
            }
            return Err(error);
        }
    };

    let mut environment = BTreeMap::new();
    environment.insert(
        request
            .runtime
            .runtime()
            .profile_environment_key()
            .to_string(),
        profile_value,
    );
    let args = match request.runtime.runtime() {
        NativeConversationRuntime::ClaudeCode => {
            vec!["--resume".to_string(), target_session_id.clone()]
        }
        NativeConversationRuntime::Codex => {
            vec!["resume".to_string(), target_session_id.clone()]
        }
    };
    let resume_plan = NativeResumePlan {
        runtime: request.runtime.runtime(),
        account_id: request.account_id.to_string(),
        native_session_id: target_session_id.clone(),
        cli_version: request.observed_cli_version.to_string(),
        model: target_model(&request.runtime).to_string(),
        model_provider: target_model_provider(&request.runtime).map(str::to_string),
        executable,
        args,
        cwd: target_workspace_root.clone(),
        environment,
        transcript_path: target_path.clone(),
        transcript_sha256_before_resume: native_sha256.clone(),
        transcript_bytes_before_resume: native_bytes_count,
        portable_sha256: encoded_portable.sha256.clone(),
    };

    Ok(NativeMaterializationCandidate {
        runtime: request.runtime.runtime(),
        account_id: request.account_id.to_string(),
        native_session_id: target_session_id,
        target_path,
        target_profile_root,
        target_workspace_root,
        recovery_root,
        cli_version: request.observed_cli_version.to_string(),
        native_sha256,
        portable_sha256: encoded_portable.sha256,
        continuation_complete: request
            .conversation
            .loss_manifest
            .is_continuation_complete(),
        resume_plan,
        published_identity,
        expected_semantics: semantics,
        target: request.runtime,
        created_at: request.created_at.to_string(),
    })
}

pub fn accept_native_resume(
    candidate: &NativeMaterializationCandidate,
    observation: NativeResumeObservation<'_>,
) -> NativeMaterializationResult<AcceptedNativeMaterialization> {
    if observation.observed_native_session_id != candidate.native_session_id {
        return Err(acceptance_error(
            "Managed CLI reported a different native session id",
        ));
    }
    if observation.first_real_user_turn.is_empty() {
        return Err(acceptance_error(
            "First real resumed user turn must not be empty",
        ));
    }
    let maximum = MAX_NATIVE_TRANSCRIPT_BYTES.checked_mul(2).ok_or_else(|| {
        NativeMaterializationError::filesystem("Native transcript size limit overflowed")
    })?;
    let (bytes, observed_identity) = read_identity_guarded(&candidate.target_path, maximum)?;
    if !same_file_identity(&candidate.published_identity, &observed_identity) {
        return Err(acceptance_error(
            "Native CLI replaced the candidate instead of appending to the verified file",
        ));
    }
    let prefix_length = usize::try_from(candidate.resume_plan.transcript_bytes_before_resume)
        .map_err(|_| acceptance_error("Native transcript prefix length cannot fit in memory"))?;
    if bytes.len() <= prefix_length {
        return Err(acceptance_error(
            "Native CLI did not append a real resume turn",
        ));
    }
    let (prefix, appended) = bytes.split_at(prefix_length);
    if sha256_hex(prefix) != candidate.native_sha256 {
        return Err(acceptance_error(
            "Native CLI changed the verified transcript prefix",
        ));
    }
    let context = NativeFormatContext {
        session_id: &candidate.native_session_id,
        workspace: &candidate.target_workspace_root,
        cli_version: &candidate.cli_version,
        target: &candidate.target,
        created_at: &candidate.created_at,
    };
    let reparsed = reparse_native(candidate.runtime, prefix, &context)?;
    require_semantic_parity(
        &candidate.expected_semantics,
        &reparsed,
        "pre-resume native prefix",
    )?;
    let observed_turn =
        appended_first_user_turn(candidate.runtime, appended, &candidate.native_session_id)?
            .ok_or_else(|| acceptance_error("Native CLI append has no model-visible user turn"))?;
    if observed_turn != observation.first_real_user_turn {
        return Err(acceptance_error(
            "Native CLI append does not contain the exact first real user turn",
        ));
    }
    Ok(AcceptedNativeMaterialization {
        runtime: candidate.runtime,
        account_id: candidate.account_id.clone(),
        native_session_id: candidate.native_session_id.clone(),
        cli_version: candidate.cli_version.clone(),
        model: target_model(&candidate.target).to_string(),
        model_provider: target_model_provider(&candidate.target).map(str::to_string),
        target_profile_root: candidate.target_profile_root.clone(),
        target_workspace_root: candidate.target_workspace_root.clone(),
        transcript_path: candidate.target_path.clone(),
        portable_sha256: candidate.portable_sha256.clone(),
        transcript_sha256_after_resume: sha256_hex(&bytes),
        transcript_bytes_after_resume: observed_identity.bytes,
    })
}

pub fn reject_native_materialization(
    candidate: NativeMaterializationCandidate,
) -> NativeMaterializationResult<RejectedNativeMaterialization> {
    let runtime_directory = match candidate.runtime {
        NativeConversationRuntime::ClaudeCode => "claude-code",
        NativeConversationRuntime::Codex => "codex",
    };
    let recovery_directory = ensure_private_relative_directory(
        &candidate.recovery_root,
        &Path::new("rejected-native-sessions").join(runtime_directory),
    )?;
    let recovery_name = format!("{}.jsonl", candidate.native_session_id);
    let recovery_path = move_candidate_to_recovery(
        &candidate.target_path,
        &candidate.published_identity,
        &recovery_directory,
        &recovery_name,
    )?;
    Ok(RejectedNativeMaterialization {
        runtime: candidate.runtime,
        native_session_id: candidate.native_session_id,
        recovery_path,
    })
}

fn validate_request_strings(
    request: &NativeMaterializationRequest<'_>,
) -> NativeMaterializationResult<()> {
    validate_explicit_axis("account id", request.account_id)?;
    match &request.runtime {
        NativeRuntimeTarget::ClaudeCode { model } => validate_explicit_axis("Claude model", model),
        NativeRuntimeTarget::Codex {
            model,
            model_provider,
        } => {
            validate_explicit_axis("Codex model", model)?;
            validate_explicit_axis("Codex model provider", model_provider)
        }
    }
}

fn target_model(target: &NativeRuntimeTarget) -> &str {
    match target {
        NativeRuntimeTarget::ClaudeCode { model } | NativeRuntimeTarget::Codex { model, .. } => {
            model
        }
    }
}

fn target_model_provider(target: &NativeRuntimeTarget) -> Option<&str> {
    match target {
        NativeRuntimeTarget::ClaudeCode { .. } => None,
        NativeRuntimeTarget::Codex { model_provider, .. } => Some(model_provider),
    }
}

fn validate_explicit_axis(label: &str, value: &str) -> NativeMaterializationResult<()> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(NativeMaterializationError::invalid(format!(
            "Explicit {label} must be non-empty and contain no control characters"
        )));
    }
    Ok(())
}

fn validate_version(
    runtime: NativeConversationRuntime,
    version: &str,
) -> NativeMaterializationResult<()> {
    let supported = match runtime {
        NativeConversationRuntime::ClaudeCode => CLAUDE_CODE_SUPPORTED_VERSIONS,
        NativeConversationRuntime::Codex => CODEX_SUPPORTED_VERSIONS,
    };
    if supported.contains(&version) {
        Ok(())
    } else {
        Err(NativeMaterializationError::new(
            NativeMaterializationFailureKind::UnsupportedRuntimeVersion,
            format!(
                "Native materialization is not frozen for {} version {version}",
                runtime.cli_agent_type()
            ),
        ))
    }
}

fn target_location(
    runtime: NativeConversationRuntime,
    profile_root: &Path,
    workspace_root: &Path,
    session_id: &str,
    created_at: DateTime<Utc>,
) -> NativeMaterializationResult<(PathBuf, String)> {
    match runtime {
        NativeConversationRuntime::Codex => {
            let relative = Path::new("sessions")
                .join(created_at.format("%Y").to_string())
                .join(created_at.format("%m").to_string())
                .join(created_at.format("%d").to_string());
            let directory = ensure_private_relative_directory(profile_root, &relative)?;
            Ok((
                directory,
                format!(
                    "rollout-{}-{session_id}.jsonl",
                    created_at.format("%Y-%m-%dT%H-%M-%S")
                ),
            ))
        }
        NativeConversationRuntime::ClaudeCode => {
            let workspace = workspace_root.to_str().ok_or_else(|| {
                NativeMaterializationError::invalid("Target workspace is not valid UTF-8")
            })?;
            let encoded = workspace
                .chars()
                .map(|character| {
                    if character.is_ascii_alphanumeric() {
                        character
                    } else {
                        '-'
                    }
                })
                .collect::<String>();
            let relative = Path::new("projects").join(if encoded.is_empty() {
                "-".to_string()
            } else {
                encoded
            });
            let directory = ensure_private_relative_directory(profile_root, &relative)?;
            Ok((directory, format!("{session_id}.jsonl")))
        }
    }
}

fn reject_reused_source_identity(
    source_session_id: &str,
    target_session_id: &str,
) -> NativeMaterializationResult<()> {
    let source_is_target = source_session_id == target_session_id
        || source_session_id
            .strip_suffix(target_session_id)
            .is_some_and(|prefix| prefix.ends_with('-'));
    if source_is_target {
        return Err(NativeMaterializationError::invalid(
            "Target native session id must be fresh and differ from the imported source",
        ));
    }
    Ok(())
}

fn reject_same_source_path(
    source_path: Option<&Path>,
    target_path: &Path,
) -> NativeMaterializationResult<()> {
    let Some(source_path) = source_path else {
        return Ok(());
    };
    if !source_path.is_absolute() {
        return Err(NativeMaterializationError::invalid(
            "Source native path guard must be absolute",
        ));
    }
    let source = std::fs::canonicalize(source_path).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to resolve source native path guard {}: {error}",
            source_path.display()
        ))
    })?;
    let target_parent = target_path.parent().ok_or_else(|| {
        NativeMaterializationError::filesystem("Native target has no parent directory")
    })?;
    let target_parent = std::fs::canonicalize(target_parent).map_err(|error| {
        NativeMaterializationError::filesystem(format!(
            "Failed to resolve native target parent: {error}"
        ))
    })?;
    let filename = target_path
        .file_name()
        .ok_or_else(|| NativeMaterializationError::filesystem("Native target has no filename"))?;
    let target = target_parent.join(filename);
    if source == target {
        return Err(NativeMaterializationError::invalid(
            "Source and target native transcript paths must differ",
        ));
    }
    Ok(())
}

fn require_semantic_parity(
    expected: &[crate::semantic::NativeSemanticGroup],
    observed: &[crate::semantic::NativeSemanticGroup],
    label: &str,
) -> NativeMaterializationResult<()> {
    if expected != observed {
        return Err(NativeMaterializationError::parity(format!(
            "Independent target reader found model-visible semantic loss in {label}"
        )));
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn acceptance_error(message: impl Into<String>) -> NativeMaterializationError {
    NativeMaterializationError::new(NativeMaterializationFailureKind::AcceptanceFailed, message)
}

#[cfg(all(test, any(target_os = "linux", target_os = "macos")))]
pub(crate) fn prepare_with_corruption_fault(
    request: NativeMaterializationRequest<'_>,
) -> NativeMaterializationResult<NativeMaterializationCandidate> {
    prepare_native_materialization_inner(request, PreparationFault::CorruptAfterPublish)
}
