use super::store;
use super::types::{
    ConversationExecutionAbortCandidateRequest, ConversationExecutionActivateCandidateRequest,
    ConversationExecutionAdvanceCheckpointRequest,
    ConversationExecutionBeginMaterializationRequest,
    ConversationExecutionImportLegacyRunnersRequest, ConversationExecutionKey,
    ConversationExecutionMutationResult, ConversationExecutionPrepareCandidateRequest,
    ConversationExecutionRetireActiveRequest, ConversationExecutionSnapshot,
    ConversationRunnerCleanupCandidatesRequest, ConversationRunnerIdentityRequest,
    ConversationRunnerMutationResult, ConversationRunnerPage, ConversationRunnerPageRequest,
    ConversationRunnerRegistration,
};

async fn blocking<T, F>(operation: &'static str, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|err| format!("conversation execution {operation} worker failed: {err}"))?
}

#[tauri::command]
pub async fn conversation_execution_get(
    request: ConversationExecutionKey,
) -> Result<Option<ConversationExecutionSnapshot>, String> {
    blocking("load", move || store::load_snapshot(&request)).await
}

#[tauri::command]
pub async fn conversation_execution_prepare_candidate(
    request: ConversationExecutionPrepareCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("candidate prepare", move || {
        store::prepare_candidate(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_begin_materialization(
    request: ConversationExecutionBeginMaterializationRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("materialization start", move || {
        store::begin_materialization(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_activate_candidate(
    request: ConversationExecutionActivateCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("candidate activation", move || {
        store::activate_candidate(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_abort_candidate(
    request: ConversationExecutionAbortCandidateRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("candidate abort", move || store::abort_candidate(request)).await
}

#[tauri::command]
pub async fn conversation_execution_advance_checkpoint(
    request: ConversationExecutionAdvanceCheckpointRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("checkpoint advance", move || {
        store::advance_checkpoint(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_retire_active(
    request: ConversationExecutionRetireActiveRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("active retirement", move || store::retire_active(request)).await
}

#[tauri::command]
pub async fn conversation_execution_mark_runner_terminal(
    request: ConversationRunnerIdentityRequest,
) -> Result<ConversationRunnerMutationResult, String> {
    blocking("runner terminal mark", move || {
        store::mark_runner_terminal(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_forget_runner(
    request: ConversationRunnerIdentityRequest,
) -> Result<ConversationRunnerMutationResult, String> {
    blocking("runner forget", move || store::forget_runner(request)).await
}

#[tauri::command]
pub async fn conversation_execution_list_runner_ids(
    request: ConversationRunnerPageRequest,
) -> Result<ConversationRunnerPage, String> {
    blocking("runner list", move || store::list_runner_ids(request)).await
}

#[tauri::command]
pub async fn conversation_execution_list_cleanup_candidates(
    request: ConversationRunnerCleanupCandidatesRequest,
) -> Result<Vec<ConversationRunnerRegistration>, String> {
    blocking("cleanup candidate list", move || {
        store::list_cleanup_candidates(request)
    })
    .await
}

#[tauri::command]
pub async fn conversation_execution_import_legacy_runners(
    request: ConversationExecutionImportLegacyRunnersRequest,
) -> Result<ConversationExecutionMutationResult, String> {
    blocking("legacy runner import", move || {
        store::import_legacy_runners(request)
    })
    .await
}
