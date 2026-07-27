//! `PlanResolution` and the single chokepoint (`resolve_pending`) that
//! terminates a pending plan, regardless of which surface triggered it.

use tracing::{info, warn};

use super::events::{build_plan_approval_event, PlanApprovalCardStatus};
use super::manager::PlanApprovalManager;
use super::persistence::PlanApprovalStore;
use super::snapshot::PendingPlanApproval;

/// Terminal outcome for a pending plan. Every transition out of the
/// "pending" state — regardless of which surface triggered it — must go
/// through [`resolve_pending`] so the DB row, the in-memory slot, the
/// transcript card event, and the FE broadcast can never diverge.
///
/// A pending plan is session-level state, decoupled from the exec mode:
/// switching the ModePill, chatting in Build mode, Stop, and app restarts
/// all leave it pending. Only the resolutions below terminate it.
#[derive(Debug)]
pub enum PlanResolution {
    /// User clicked Build. `edited` carries the user-modified plan body
    /// when the approval came through "approve with edits".
    Approved { edited: Option<String> },
    /// User clicked Skip.
    Rejected,
    /// A newer plan revision replaced this one (`mark_ready` on a session
    /// that already had a pending plan).
    Superseded,
    /// Housekeeping: plan file missing or session deleted (startup GC /
    /// rehydrate validation).
    Orphaned,
}

impl PlanResolution {
    fn card_status(&self) -> PlanApprovalCardStatus {
        match self {
            Self::Approved { .. } => PlanApprovalCardStatus::Approved,
            Self::Rejected => PlanApprovalCardStatus::Cancelled,
            Self::Superseded | Self::Orphaned => PlanApprovalCardStatus::Archived,
        }
    }

    fn source_label(&self) -> &'static str {
        match self {
            Self::Approved { .. } => "approval",
            Self::Rejected => "rejection",
            Self::Superseded => "archive",
            Self::Orphaned => "orphan",
        }
    }

    fn broadcasts_archived(&self) -> bool {
        matches!(self, Self::Superseded | Self::Orphaned)
    }
}

/// Single chokepoint for resolving a session's pending plan.
///
/// Atomically (DB row deletion is the linearization point):
///   1. Takes the in-memory snapshot from `manager` when provided (live
///      session fast path), falling back to the persisted row (post-restart
///      / CLI / GC path).
///   2. Deletes the `pending_plan_approvals` row — the authoritative state.
///   3. For `Approved { edited: Some(_) }`, persists the edited plan body
///      to the plan file before anything reads it back.
///   4. Pushes the terminal `plan_approval` transcript event (approved /
///      cancelled / archived) through the event pipeline.
///   5. Broadcasts `agent:plan_approval_archived` for Superseded /
///      Orphaned so a live FE un-pins immediately.
///
/// Returns the resolved snapshot, or `None` when nothing was pending.
/// Idempotent: concurrent callers race on the DB delete; only the caller
/// that observed the row (or the in-memory slot) emits events.
pub async fn resolve_pending(
    session_id: &str,
    resolution: PlanResolution,
    manager: Option<&PlanApprovalManager>,
) -> Option<PendingPlanApproval> {
    // Live-session fast path: the manager's mutex is the serialization
    // point while a session is running.
    let mut snapshot: Option<PendingPlanApproval> = None;
    if let Some(manager) = manager {
        let mut guard = manager.pending.lock().await;
        snapshot = guard.take();
    }

    if snapshot.is_none() {
        let sid = session_id.to_string();
        let loaded =
            tokio::task::spawn_blocking(move || PlanApprovalStore::load_by_session(&sid)).await;
        match loaded {
            Ok(Ok(row)) => snapshot = row.map(PendingPlanApproval::from_row),
            Ok(Err(err)) => {
                warn!("[plan_approval] resolve_pending load failed for {session_id}: {err}");
                return None;
            }
            Err(err) => {
                warn!("[plan_approval] resolve_pending join error for {session_id}: {err}");
                return None;
            }
        }
    }

    let snapshot = snapshot?;

    let sid = snapshot.session_id.clone();
    super::gc::persist_blocking(move || PlanApprovalStore::delete_by_session(&sid)).await;

    if let PlanResolution::Approved {
        edited: Some(ref new_content),
    } = resolution
    {
        if let Err(err) = std::fs::write(&snapshot.plan_path, new_content.as_bytes()) {
            warn!(
                "[plan_approval] failed to persist edited plan {}: {err}",
                snapshot.plan_path
            );
        }
    }

    // Feed the Plan-mode re-entry note: remember where the resolved plan
    // lives so a later return to Plan mode points the model at it.
    // Superseded plans are replaced by a live pending revision and
    // orphaned plan files are gone — neither warrants a note.
    if matches!(
        resolution,
        PlanResolution::Approved { .. } | PlanResolution::Rejected
    ) {
        crate::session::plan_mode::record_last_resolved_plan(
            &snapshot.session_id,
            crate::session::plan_mode::LastResolvedPlan {
                plan_path: snapshot.plan_path.clone(),
                plan_title: snapshot.plan_title.clone(),
                approved: matches!(resolution, PlanResolution::Approved { .. }),
            },
        );
    }

    let app_handle = manager
        .and_then(|manager| {
            manager
                .app_handle
                .lock()
                .ok()
                .and_then(|guard| guard.clone())
        })
        .or_else(|| super::GLOBAL_APP_HANDLE.get().cloned());
    if let Some(handle) = app_handle {
        let mut event = build_plan_approval_event(
            &snapshot,
            resolution.source_label(),
            resolution.card_status(),
        );
        event.recompute_extracted();
        crate::bus::event_pipeline_bridge::push_events(&handle, &snapshot.session_id, vec![event]);
        // Backend-authoritative finalize of the persisted `awaiting_user`
        // events tied to this revision (pending card + create_plan tool
        // call). The FE `handlePlanApprovalArchived` patch becomes a
        // redundant fast-path - a missed broadcast can no longer strand
        // the events and wedge the planning indicator.
        crate::bus::event_pipeline_bridge::finalize_plan_revision_events(
            &handle,
            &snapshot.session_id,
            &snapshot.plan_revision_id,
        );
    }

    if resolution.broadcasts_archived() {
        crate::bus::broadcast_event(
            "agent:plan_approval_archived",
            serde_json::json!({
                "sessionId": &snapshot.session_id,
                "planPath": &snapshot.plan_path,
                "toolCallId": &snapshot.tool_call_id,
                "planId": &snapshot.plan_id,
                "planRevisionId": &snapshot.plan_revision_id,
                "reason": resolution.source_label(),
            }),
        );
    }

    info!(
        "[plan_approval] Pending plan resolved (session={}, resolution={}, path={})",
        snapshot.session_id,
        resolution.source_label(),
        snapshot.plan_path
    );

    Some(snapshot)
}
