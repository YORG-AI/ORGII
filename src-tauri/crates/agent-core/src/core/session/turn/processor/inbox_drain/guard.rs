//! [`DrainGuard`] — deferred mark-read commit returned by
//! [`super::drain_and_render_deferred`].

use crate::coordination::agent_inbox::AgentInboxStore;
use crate::session::persistence::AgentOrgInboxTranscriptMaterialization;
use tracing::{info, warn};

/// Pending mark-read commit returned by [`super::drain_and_render_deferred`].
///
/// The guard owns the IDs of inbox rows that were materialised into the
/// turn's in-memory `messages` vector and applied as side effects, but
/// have **not yet been marked read**. Callers must invoke [`Self::commit`]
/// only after the turn has progressed past the point where a failure
/// would cause the rendered attachment to be permanently lost (i.e.
/// the user-message has been persisted and / or the turn has succeeded).
///
/// If the guard is dropped without `commit()`, the rows stay unread and
/// will be re-drained on the next turn — strictly preferable to the
/// alternative (marking read on a turn that ultimately fails, losing
/// the messages forever). Rows are only marked read after they are
/// reliably queued.
#[must_use = "DrainGuard::commit must be called after the turn succeeds; \
              dropping without commit leaves rows unread for next turn"]
pub struct DrainGuard {
    run_id: String,
    recipient_member_id: String,
    materialization_session_id: Option<String>,
    pending_ids: Vec<i64>,
    new_materialization_ids: Vec<i64>,
    transcript_content: Option<String>,
    materializations: Vec<AgentOrgInboxTranscriptMaterialization>,
}

impl DrainGuard {
    pub(super) fn empty(run_id: &str, recipient_member_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            recipient_member_id: recipient_member_id.to_string(),
            materialization_session_id: None,
            pending_ids: Vec::new(),
            new_materialization_ids: Vec::new(),
            transcript_content: None,
            materializations: Vec::new(),
        }
    }

    pub(super) fn drained(
        run_id: &str,
        recipient_member_id: &str,
        materialization_session_id: Option<&str>,
        pending_ids: Vec<i64>,
        new_materialization_ids: Vec<i64>,
        transcript: Option<String>,
        materializations: Vec<AgentOrgInboxTranscriptMaterialization>,
    ) -> Self {
        Self {
            run_id: run_id.to_string(),
            recipient_member_id: recipient_member_id.to_string(),
            materialization_session_id: materialization_session_id.map(str::to_string),
            pending_ids,
            new_materialization_ids,
            transcript_content: transcript,
            materializations,
        }
    }

    pub fn transcript_content(&self) -> Option<&str> {
        self.transcript_content.as_deref()
    }

    pub fn has_pending_input(&self) -> bool {
        !self.pending_ids.is_empty()
    }

    /// Exact source rows this turn will acknowledge only after successful
    /// provider execution. Threaded into tool-call context so prospective
    /// finality can project this turn's guaranteed commit without treating
    /// unrelated unread mail as consumed.
    pub fn pending_ids(&self) -> &[i64] {
        &self.pending_ids
    }

    pub fn new_materialization_ids(&self) -> &[i64] {
        &self.new_materialization_ids
    }

    pub fn materializations(&self) -> &[AgentOrgInboxTranscriptMaterialization] {
        &self.materializations
    }

    pub fn remember_materialization(
        &mut self,
        materialization: AgentOrgInboxTranscriptMaterialization,
    ) {
        if !self
            .materializations
            .iter()
            .any(|existing| existing.message_id == materialization.message_id)
        {
            self.materializations.push(materialization);
        }
    }

    /// Stable transcript/event identities for this exact inbox delivery set.
    /// A replay after the transcript write but before `commit()` reuses these
    /// ids, so persistence is idempotent while the source rows remain unread.
    pub fn transcript_identity(&self, session_id: &str) -> Option<(String, String)> {
        if self.new_materialization_ids.is_empty() || self.transcript_content.is_none() {
            return None;
        }
        let mut material = format!(
            "{}\0{}\0{}",
            self.run_id, self.recipient_member_id, session_id
        );
        for id in &self.new_materialization_ids {
            material.push('\0');
            material.push_str(&id.to_string());
        }
        let digest = blake3::hash(material.as_bytes()).to_hex().to_string();
        Some((
            format!("agent-org-inbox-transcript-{digest}"),
            format!("agent-org-inbox-intent-{digest}"),
        ))
    }

    /// Number of rows that were drained-and-rendered. `0` means there
    /// was nothing to commit and `commit()` is a no-op.
    ///
    /// Used by the test-only [`super::drain_and_render`] wrapper to report
    /// the drain count after immediate commit, and by the
    /// `drain-inbox` debug endpoint so E2E scenarios can assert how
    /// many rows the call drained without re-reading the inbox after
    /// commit. Production turn code does not consult it.
    pub fn drained_count(&self) -> usize {
        self.pending_ids.len()
    }

    /// Mark all drained rows as read. Idempotent w.r.t. partial mark
    /// failures: any row that already happens to be marked read is
    /// silently skipped by the underlying store. Failures are logged
    /// and swallowed — re-drain on the next turn is the recovery.
    pub fn commit(self) {
        if self.pending_ids.is_empty() {
            return;
        }
        let result = match self.materialization_session_id.as_deref() {
            Some(session_id) => {
                AgentInboxStore::mark_many_read_for_session(&self.pending_ids, session_id)
            }
            None => AgentInboxStore::mark_many_read(&self.pending_ids),
        };
        match result {
            Ok(updated) => {
                info!(
                    run_id = %self.run_id,
                    member_id = %self.recipient_member_id,
                    marked = updated,
                    pending = self.pending_ids.len(),
                    "[inbox_drain] marked drained rows as read after turn success"
                );
            }
            Err(err) => {
                warn!(
                    run_id = %self.run_id,
                    member_id = %self.recipient_member_id,
                    error = %err,
                    pending = self.pending_ids.len(),
                    "[inbox_drain] mark_many_read failed; rows will be re-drained next turn"
                );
            }
        }
    }

    /// Unit-test convenience for pure rendering tests that do not execute the
    /// production transcript-materialization step. Production code must use
    /// [`Self::commit`] so receipt ownership is enforced.
    #[cfg(test)]
    pub(super) fn commit_without_materialization_for_test(self) {
        if self.pending_ids.is_empty() {
            return;
        }
        AgentInboxStore::mark_many_read(&self.pending_ids)
            .expect("test inbox acknowledgement should succeed");
    }
}
