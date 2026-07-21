//! `PlanApprovalManager` — the per-session, in-memory front door for
//! recording, querying, and rehydrating a pending plan. Terminal
//! transitions (Build / Skip) delegate to [`super::resolution::resolve_pending`].

use std::sync::Arc;

use tokio::sync::Mutex;
use tracing::info;

use super::events::{build_plan_approval_event, PlanApprovalCardStatus};
use super::gc::{persist_blocking, persist_ready_row};
use super::persistence::PlanApprovalStore;
use super::resolution::{resolve_pending, PlanResolution};
use super::snapshot::{auto_approve_deadline_ms, plan_id_for, revision_id_for, PendingPlanApproval};
use super::watcher::spawn_auto_approve_watcher;

pub struct PlanApprovalManager {
    pub(super) pending: Arc<Mutex<Option<PendingPlanApproval>>>,
    pub(super) app_handle: Arc<std::sync::Mutex<Option<tauri::AppHandle>>>,
}

impl PlanApprovalManager {
    pub fn new() -> Self {
        Self {
            pending: Arc::new(Mutex::new(None)),
            app_handle: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn set_app_handle(&self, app_handle: Option<tauri::AppHandle>) {
        if let Ok(mut guard) = self.app_handle.lock() {
            *guard = app_handle;
        }
    }

    fn push_plan_approval_event(
        &self,
        snapshot: &PendingPlanApproval,
        source: &str,
        status: PlanApprovalCardStatus,
    ) {
        let app_handle = self.app_handle.lock().ok().and_then(|guard| guard.clone());
        let Some(handle) = app_handle else {
            return;
        };
        let mut event = build_plan_approval_event(snapshot, source, status);
        event.recompute_extracted();
        crate::bus::event_pipeline_bridge::push_events(&handle, &snapshot.session_id, vec![event]);
    }

    /// Record a pending plan and broadcast `agent:plan_ready_for_approval`.
    ///
    /// If a previous plan was still pending we emit
    /// `agent:plan_approval_archived` so the FE can gray out the old
    /// Build button before overwriting the snapshot.
    pub async fn mark_ready(
        &self,
        session_id: &str,
        plan_path: &str,
        plan_title: &str,
        plan_content: &str,
        tool_call_id: Option<&str>,
    ) {
        let mut guard = self.pending.lock().await;

        // Superseded: a newer revision replaces the pending one. The
        // in-memory slot is the fast path; the DB fallback covers callers
        // that construct a fresh manager per registration (CLI runner) —
        // without it the previous revision's row would survive and the FE
        // would show two live Build cards.
        let prev = match guard.take() {
            Some(prev) => Some(prev),
            None => {
                let sid = session_id.to_string();
                tokio::task::spawn_blocking(move || PlanApprovalStore::load_by_session(&sid))
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .flatten()
                    .map(PendingPlanApproval::from_row)
            }
        };
        if let Some(prev) = prev.as_ref() {
            self.push_plan_approval_event(prev, "archive", PlanApprovalCardStatus::Archived);
            // Backend-authoritative finalize of the superseded revision's
            // awaiting_user events (same contract as `resolve_pending`).
            if let Some(handle) = self.app_handle.lock().ok().and_then(|guard| guard.clone()) {
                crate::bus::event_pipeline_bridge::finalize_plan_revision_events(
                    &handle,
                    &prev.session_id,
                    &prev.plan_revision_id,
                );
            }
            let archived = serde_json::json!({
                "sessionId": &prev.session_id,
                "planPath": &prev.plan_path,
                "toolCallId": &prev.tool_call_id,
                "planId": &prev.plan_id,
                "planRevisionId": &prev.plan_revision_id,
                "reason": "archive",
            });
            crate::bus::broadcast_event("agent:plan_approval_archived", archived);
        }

        let plan_id = plan_id_for(session_id, plan_path);
        let plan_revision_id = revision_id_for(tool_call_id, &plan_id);
        let created_at_ms = chrono::Utc::now().timestamp_millis();
        let snapshot = PendingPlanApproval {
            session_id: session_id.to_string(),
            tool_call_id: Some(plan_revision_id.clone()),
            plan_id,
            plan_revision_id,
            origin_tool_call_id: tool_call_id.map(str::to_string),
            plan_path: plan_path.to_string(),
            plan_title: plan_title.to_string(),
            plan_content: plan_content.to_string(),
            created_at_ms,
        };
        let previous_session_id = prev.map(|prev| prev.session_id);
        let row = snapshot.to_row();

        *guard = Some(snapshot.clone());
        // Keep the in-memory slot and its restart-persistent mirror inside
        // one serialization boundary. The auto-approve watcher must never
        // observe the new revision before its row exists.
        persist_ready_row(previous_session_id, row).await;
        drop(guard);

        // A live pending plan supersedes the Plan-mode re-entry note that
        // a previously resolved plan may have left behind.
        crate::session::plan_mode::clear_last_resolved_plan(session_id);

        self.push_plan_approval_event(&snapshot, "create_plan", PlanApprovalCardStatus::Pending);

        // Presence policy: initial auto-approve deadline (if any) rides on
        // the broadcast so the FE can render a countdown on the Build card.
        let auto_approve_at_ms = auto_approve_deadline_ms(snapshot.created_at_ms);

        let payload = serde_json::json!({
            "sessionId": &snapshot.session_id,
            "planPath": &snapshot.plan_path,
            "planTitle": &snapshot.plan_title,
            "planContent": &snapshot.plan_content,
            "toolCallId": &snapshot.tool_call_id,
            "planId": &snapshot.plan_id,
            "planRevisionId": &snapshot.plan_revision_id,
            "originToolCallId": &snapshot.origin_tool_call_id,
            "planEventSource": "create_plan",
            "autoApproveAt": auto_approve_at_ms,
        });
        crate::bus::broadcast_event("agent:plan_ready_for_approval", payload);

        spawn_auto_approve_watcher(
            snapshot.session_id.clone(),
            snapshot.plan_revision_id.clone(),
            created_at_ms,
            self.pending.clone(),
        );

        info!(
            "[plan_approval] Plan ready (session={}, path={})",
            snapshot.session_id, snapshot.plan_path
        );
    }

    /// Consume the pending snapshot after the user clicks Build. Returns
    /// `None` if nothing was pending (e.g. the user clicked stale button).
    ///
    /// Thin wrapper over [`resolve_pending`] — kept for call sites and tests
    /// that hold a manager reference.
    pub async fn take_pending(&self) -> Option<PendingPlanApproval> {
        resolve_pending("", PlanResolution::Approved { edited: None }, Some(self)).await
    }

    /// Consume the pending snapshot after the user skips the plan. Returns
    /// `None` if nothing was pending (e.g. the user clicked stale button).
    ///
    /// Thin wrapper over [`resolve_pending`].
    pub async fn reject_pending(&self) -> Option<PendingPlanApproval> {
        resolve_pending("", PlanResolution::Rejected, Some(self)).await
    }

    pub async fn is_pending(&self) -> bool {
        self.pending.lock().await.is_some()
    }

    /// Snapshot the pending request without consuming it. Used by debug
    /// endpoints and FE re-mount.
    pub async fn pending_snapshot(&self) -> Option<PendingPlanApproval> {
        self.pending.lock().await.clone()
    }

    /// Durably update the body of the current pending plan without resolving it.
    ///
    /// The pending mutex serializes Save against Build/Skip/supersede. The plan
    /// file is written before the SQLite row, and restored to its prior bytes if
    /// the row update fails, so the two durable representations cannot silently
    /// diverge. `plan_revision_id` prevents a stale card from editing a newer
    /// pending revision for the same session.
    pub async fn update_pending_content(
        &self,
        session_id: &str,
        plan_revision_id: Option<&str>,
        content: String,
    ) -> Result<PendingPlanApproval, String> {
        let mut guard = self.pending.lock().await;
        let current = guard
            .as_ref()
            .ok_or_else(|| format!("No pending plan approval for session {session_id}"))?;

        if current.session_id != session_id {
            return Err(format!(
                "Pending plan belongs to session {}, not {session_id}",
                current.session_id
            ));
        }
        if let Some(expected_revision) = plan_revision_id {
            if current.plan_revision_id != expected_revision {
                return Err(format!(
                    "Pending plan revision changed (expected {expected_revision}, current {})",
                    current.plan_revision_id
                ));
            }
        }

        let mut updated = current.clone();
        updated.plan_content = content;
        let row = updated.to_row();
        let plan_path = updated.plan_path.clone();

        tokio::task::spawn_blocking(move || {
            let previous_bytes = std::fs::read(&plan_path).map_err(|err| {
                format!("Failed to read pending plan before Save ({plan_path}): {err}")
            })?;
            std::fs::write(&plan_path, row.plan_content.as_bytes()).map_err(|err| {
                format!("Failed to write pending plan ({plan_path}): {err}")
            })?;

            if let Err(err) = PlanApprovalStore::upsert(&row) {
                if let Err(rollback_err) = std::fs::write(&plan_path, previous_bytes) {
                    return Err(format!(
                        "Failed to persist pending plan snapshot: {err}; file rollback also failed: {rollback_err}"
                    ));
                }
                return Err(format!("Failed to persist pending plan snapshot: {err}"));
            }
            Ok::<(), String>(())
        })
        .await
        .map_err(|err| format!("Pending plan Save task failed: {err}"))??;

        *guard = Some(updated.clone());
        Ok(updated)
    }

    /// Synchronous best-effort pending snapshot for LLM schema rendering.
    ///
    /// Tool descriptions are built through a synchronous trait method, so they
    /// cannot await `pending_snapshot()`. If the mutex is temporarily held, skip
    /// the live hint rather than blocking schema generation.
    pub fn pending_snapshot_now(&self) -> Option<PendingPlanApproval> {
        self.pending.try_lock().ok().and_then(|guard| guard.clone())
    }

    /// Drop the in-memory pending entry — called on session cancel /
    /// session drop. The DB row is deliberately KEPT: a Stop or eviction is
    /// not a decision about the plan, and the next mount / rehydrate must
    /// restore the pending Build card from the persisted row.
    pub async fn clear_silently(&self) {
        let mut guard = self.pending.lock().await;
        if guard.take().is_some() {
            info!("[plan_approval] Pending plan cleared from memory (session cancel); DB row kept");
        }
    }

    /// Load any persisted pending plan for `session_id` into the in-memory
    /// slot, and replay `agent:plan_ready_for_approval` so the frontend's
    /// existing rehydration path in `useSessionSync.ts` re-enables the Build
    /// button.
    ///
    /// Called from `agent_core::init` once per session activation (i.e. the
    /// first time the runtime is built for that session id after an app
    /// start). If the persisted plan file no longer exists on disk — the
    /// user deleted it between sessions — the row is removed and no
    /// broadcast is emitted.
    ///
    /// This must be called while no other caller can concurrently invoke
    /// `mark_ready` / `take_pending` / `clear_silently` for the same
    /// session. Per-session serialization is guaranteed by `init.rs`
    /// running this before registering the tools that would trigger those
    /// paths.
    pub async fn rehydrate_from_db(&self, session_id: &str) -> Result<(), String> {
        let sid = session_id.to_string();
        let loaded = tokio::task::spawn_blocking(move || PlanApprovalStore::load_by_session(&sid))
            .await
            .map_err(|err| format!("[plan_approval] rehydrate join error: {err}"))?
            .map_err(|err| format!("[plan_approval] rehydrate load error: {err}"))?;

        let Some(row) = loaded else {
            return Ok(());
        };

        // Validate the plan file still exists. If the user deleted it
        // between sessions there is nothing to approve, so drop the row
        // and stay silent.
        if !std::path::Path::new(&row.plan_path).exists() {
            let sid = row.session_id.clone();
            persist_blocking(move || PlanApprovalStore::delete_by_session(&sid)).await;
            info!(
                "[plan_approval] Rehydrate skipped: plan file missing (session={}, path={})",
                row.session_id, row.plan_path
            );
            return Ok(());
        }

        // A pending plan survives mode switches: no exec-mode gate here.
        // Only a missing plan file (above) or a deleted session (GC) can
        // orphan the row.

        let snapshot = PendingPlanApproval::from_row(row);

        let mut guard = self.pending.lock().await;
        *guard = Some(snapshot.clone());
        drop(guard);

        self.push_plan_approval_event(&snapshot, "rehydrate", PlanApprovalCardStatus::Pending);

        let auto_approve_at_ms = auto_approve_deadline_ms(snapshot.created_at_ms);

        let payload = serde_json::json!({
            "sessionId": &snapshot.session_id,
            "planPath": &snapshot.plan_path,
            "planTitle": &snapshot.plan_title,
            "planContent": &snapshot.plan_content,
            "toolCallId": &snapshot.tool_call_id,
            "planId": &snapshot.plan_id,
            "planRevisionId": &snapshot.plan_revision_id,
            "originToolCallId": &snapshot.origin_tool_call_id,
            "planEventSource": "rehydrate",
            "autoApproveAt": auto_approve_at_ms,
        });
        crate::bus::broadcast_event("agent:plan_ready_for_approval", payload);

        spawn_auto_approve_watcher(
            snapshot.session_id.clone(),
            snapshot.plan_revision_id.clone(),
            snapshot.created_at_ms,
            self.pending.clone(),
        );

        info!(
            "[plan_approval] Rehydrated pending plan from DB (session={}, path={})",
            snapshot.session_id, snapshot.plan_path
        );
        Ok(())
    }
}

impl Default for PlanApprovalManager {
    fn default() -> Self {
        Self::new()
    }
}
