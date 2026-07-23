//! Per-batch consolidation loop + provider/mode resolution.
//!
//! `consolidate_batch` is the inner loop driven by `super::entry::consolidate`:
//! one `(scope, account_id)` group at a time, drains pending rows,
//! short-circuits on hash matches, calls `recall::*` then `decision`-side
//! LLM, and applies the resulting state transition via `events::apply_event`.

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use std::sync::Arc;
use tracing::{debug, warn};

use super::decision::{build_decision_prompt, parse_decision};
use super::events::{apply_event, EventCounts};
use super::recall::{recall_mode_embedding, recall_mode_manifest};
use super::types::CandidateMode;
use crate::core::side_query::{side_query_typed, SideQueryConfig, SideQueryError};
use crate::providers::traits::{LLMProvider, ProviderError};
use crate::specialization::memory::embeddings::{AutoEmbeddingProvider, EmbeddingProvider};
use crate::specialization::memory::learnings::{self, Learning};

/// Context passed into `consolidate_batch`: all the pre-resolved knobs that
/// don't change per pending row.
pub(super) struct BatchContext<'a> {
    pub scope: &'a str,
    pub provider: Arc<dyn LLMProvider>,
    pub model: String,
    pub mode: CandidateMode,
    pub embed: Option<Arc<AutoEmbeddingProvider>>,
}

fn is_capacity_blocker(err: &SideQueryError) -> bool {
    matches!(
        err,
        SideQueryError::Provider(ProviderError::RateLimited { .. })
            | SideQueryError::Provider(ProviderError::Overloaded { .. })
    )
}

fn abandon_after_consolidation_failure(
    conn: &Connection,
    pending: &Learning,
    reason: &str,
) -> bool {
    match learnings::abandon_pending(conn, &pending.id) {
        Ok(true) => {
            warn!(
                "[consolidation] abandoned pending={} scope={} after consolidation failure reason={}",
                pending.id, pending.agent_scope, reason
            );
            true
        }
        Ok(false) => false,
        Err(err) => {
            warn!(
                "[consolidation] failed to abandon pending={} scope={} reason={}: {}; row may retry",
                pending.id, pending.agent_scope, reason, err
            );
            false
        }
    }
}

/// Run the consolidation loop for one `(scope, account_id)` batch. Returns
/// the populated counters so the caller can log and persist a
/// `consolidation_runs` row.
pub(super) async fn consolidate_batch(
    conn: &Connection,
    ctx: &BatchContext<'_>,
    batch: Vec<Learning>,
) -> EventCounts {
    let mut counts = EventCounts::default();
    if batch.is_empty() {
        return counts;
    }

    let mut stop_after_capacity_blocker = false;
    for pending in batch {
        if stop_after_capacity_blocker {
            if abandon_after_consolidation_failure(conn, &pending, "batch_capacity_blocker") {
                counts.abandoned += 1;
            }
            continue;
        }

        // Short-circuit: if an identical content_hash was promoted to active
        // since we loaded this pending row, reinforce + mark merged. Saves an
        // LLM round-trip entirely.
        if let Some(hash) = pending.content_hash.as_deref() {
            // Distinguish `QueryReturnedNoRows` (legitimate "no
            // active twin yet" — fall through to full LLM
            // round-trip) from a transient DB error. The previous
            // `.ok()` collapsed both into `None`, which silently
            // skipped the short-circuit and forced the LLM
            // round-trip even when sqlite was unhealthy (we'd
            // never know the cheap path was bypassed).
            let hit: Option<String> = match conn
                .query_row(
                    "SELECT id FROM learnings
                     WHERE content_hash = ?1 AND agent_scope = ?2
                       AND status = 'active' AND id != ?3
                     LIMIT 1",
                    rusqlite::params![hash, ctx.scope, pending.id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                Ok(v) => v,
                Err(err) => {
                    warn!(
                        "[consolidation] short-circuit hash lookup DB error pending={} scope={}: {} \
                         (falling through to full LLM round-trip)",
                        pending.id, ctx.scope, err
                    );
                    None
                }
            };
            if let Some(active_id) = hit {
                debug!(
                    "[consolidation] hash short-circuit pending={} -> active={}",
                    pending.id, active_id
                );
                if let Err(err) = learnings::mark_merged(conn, &pending.id) {
                    warn!(
                        "[consolidation] mark_merged failed for pending={} (active twin={}): {}",
                        pending.id, active_id, err
                    );
                    if abandon_after_consolidation_failure(conn, &pending, "hash_merge_error") {
                        counts.abandoned += 1;
                    }
                    continue;
                }
                let now = Utc::now().to_rfc3339();
                if let Err(err) = conn.execute(
                    "UPDATE learnings
                     SET reinforcement_count = reinforcement_count + 1,
                         updated_at = ?1
                     WHERE id = ?2",
                    rusqlite::params![now, active_id],
                ) {
                    warn!(
                        "[consolidation] reinforcement_count bump failed for active={}: {}; \
                         counter will lag the actual merge count",
                        active_id, err
                    );
                }
                counts.none += 1;
                continue;
            }
        }

        // The fallback `unwrap_or_default()` calls below previously
        // turned DB-level recall failures into an empty candidate
        // list, which silently caused the LLM to choose ADD (no
        // similar neighbours found) instead of UPDATE/MERGE — exactly
        // the silent-fallback class documented in
        // `docs/agent/audit-fallbacks-0421.md`. Surface the
        // fallback failure via `warn!` and still return an empty list
        // so the consolidation pass for the surrounding scope does
        // not abort, but a partial recall miss is now traceable.
        let manifest_fallback = |reason: &str| -> Vec<Learning> {
            match recall_mode_manifest(conn, ctx.scope, &pending) {
                Ok(v) => v,
                Err(e) => {
                    warn!(
                        "[consolidation] manifest fallback after {} also failed: {}",
                        reason, e
                    );
                    Vec::new()
                }
            }
        };

        let candidates = match ctx.mode {
            CandidateMode::Embedding => match ctx.embed.as_ref() {
                None => {
                    warn!(
                        "[consolidation] mode=Embedding but no provider; falling back to Manifest"
                    );
                    manifest_fallback("Embedding-no-provider")
                }
                Some(embed) => {
                    match recall_mode_embedding(conn, ctx.scope, &pending, embed).await {
                        Ok(v) => v,
                        Err(e) => {
                            warn!(
                                "[consolidation] embedding recall failed; falling back to Manifest: {}",
                                e
                            );
                            manifest_fallback("Embedding-recall-failure")
                        }
                    }
                }
            },
            CandidateMode::Manifest => match recall_mode_manifest(conn, ctx.scope, &pending) {
                Ok(v) => v,
                Err(e) => {
                    warn!("[consolidation] manifest recall failed: {}", e);
                    Vec::new()
                }
            },
        };

        let prompt = build_decision_prompt(&pending, &candidates);
        let user_messages = vec![serde_json::json!({
            "role": "user",
            "content": prompt,
        })];
        let cfg = SideQueryConfig {
            model: Some(ctx.model.clone()),
            max_tokens: 800,
            temperature: 0.0,
            system_prompt: None,
            ..Default::default()
        };

        let llm_result = side_query_typed(&*ctx.provider, &user_messages, &cfg, &ctx.model).await;
        let response_text = match llm_result {
            Ok(r) => r.content,
            Err(err) => {
                warn!(
                    "[consolidation] LLM decision failed for pending={}: {}",
                    pending.id, err
                );
                if abandon_after_consolidation_failure(conn, &pending, "llm_error") {
                    counts.abandoned += 1;
                }
                if is_capacity_blocker(&err) {
                    warn!(
                        "[consolidation] stopping batch for scope={} after provider capacity blocker on pending={}",
                        ctx.scope, pending.id
                    );
                    stop_after_capacity_blocker = true;
                }
                continue;
            }
        };

        let decision = match parse_decision(&response_text, &candidates) {
            Ok(d) => d,
            Err(e) => {
                warn!(
                    "[consolidation] parse_decision failed for pending={}: {}",
                    pending.id, e
                );
                if abandon_after_consolidation_failure(conn, &pending, "parse_error") {
                    counts.abandoned += 1;
                }
                continue;
            }
        };

        match apply_event(conn, &pending, &decision) {
            Ok(ec) => {
                counts.added += ec.added;
                counts.updated += ec.updated;
                counts.deleted += ec.deleted;
                counts.none += ec.none;
            }
            Err(e) => {
                warn!(
                    "[consolidation] apply_event failed for pending={}: {}",
                    pending.id, e
                );
                if abandon_after_consolidation_failure(conn, &pending, "apply_error") {
                    counts.abandoned += 1;
                }
            }
        }
    }

    counts
}

/// Resolved model + account for a consolidation batch.
pub(super) struct BatchProviderInfo {
    pub model: String,
    pub account_id: Option<String>,
}

/// Pick the LLM model AND account for this batch.
///
/// **Model**: the session's recorded model (`source_session_id` →
/// `agent_sessions.model`). There is intentionally no per-agent override —
/// reusing the session's model keeps consolidation and the original turn
/// on the same provider/account, which is what the user expects.
///
/// **Account** precedence:
///   1. The batch's own `account_id` (from the learning row)
///   2. `agent_sessions.account_id` from the same source session
///
/// Returns `Err` when no model can be determined — the caller should skip
/// the batch rather than guess a model the user may not have a key for.
pub(super) fn resolve_batch_provider_info(
    conn: &Connection,
    scope: &str,
    batch: &[Learning],
    batch_account_id: Option<&str>,
) -> Result<BatchProviderInfo, String> {
    if let Some(first) = batch.first() {
        if let Some(session_id) = first.source_session_id.as_deref() {
            // Distinguish `QueryReturnedNoRows` (legitimate — the
            // referenced session row was deleted or never created,
            // fall through to the explicit "cannot resolve model"
            // error) from a transient DB error. The previous `.ok()`
            // collapsed both into `None`, so the caller would see
            // "session has no model" when the actual cause was a
            // sqlite lock or schema mismatch — making the batch
            // skip look like a config bug instead of an I/O fault.
            let row: Option<(Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT model, account_id FROM agent_sessions WHERE session_id = ?1",
                    rusqlite::params![session_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(|e| {
                    format!(
                        "scope={} session_id={} agent_sessions read failed: {}",
                        scope, session_id, e
                    )
                })?;
            if let Some((session_model, session_account)) = row {
                if let Some(model) = session_model.filter(|m| !m.is_empty()) {
                    let account = batch_account_id.map(str::to_string).or(session_account);
                    return Ok(BatchProviderInfo {
                        model,
                        account_id: account,
                    });
                }
            }
        }
    }

    Err(format!(
        "scope={} cannot resolve model for consolidation batch \
         (no source_session_id, or session has no model)",
        scope
    ))
}

/// Resolve an LLM provider for a batch. Mirrors `get_reflection_provider`
/// but accepts an explicit model + optional account id.
pub(super) fn resolve_provider(
    model: &str,
    account_id: Option<&str>,
) -> Result<Arc<dyn LLMProvider>, String> {
    let boxed = crate::providers::factory::create_provider(model, account_id)
        .map_err(|e| format!("no provider for consolidation model={}: {}", model, e))?;
    Ok(Arc::from(boxed))
}

/// Probe the agent's AutoEmbeddingProvider. `Some(provider)` → Mode A.
/// `None` → Mode B.
pub(super) async fn resolve_embed_mode(
    config: crate::integrations::config::EmbeddingConfig,
) -> (CandidateMode, Option<Arc<AutoEmbeddingProvider>>) {
    let provider = Arc::new(AutoEmbeddingProvider::from_config(config));
    let probe = provider.embed("consolidation probe").await;
    match probe {
        Ok(_) => (CandidateMode::Embedding, Some(provider)),
        Err(err) => {
            debug!(
                "[consolidation] embedding probe failed; using Manifest mode: {}",
                err
            );
            (CandidateMode::Manifest, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use crate::core::providers::finish_reason;
    use crate::providers::traits::LLMResponse;
    use crate::specialization::memory::consolidation::tests_support::{pending, setup_conn};
    use crate::specialization::memory::learnings::LearningStatus;

    struct RateLimitedProvider {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl LLMProvider for RateLimitedProvider {
        async fn chat(
            &self,
            _messages: &[Value],
            _tools: Option<&[Value]>,
            _model: &str,
            _max_tokens: u32,
            _temperature: f32,
        ) -> Result<LLMResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Err(ProviderError::RateLimited {
                message: "quota exhausted".to_string(),
                retry_after_secs: Some(3600),
            })
        }

        fn default_model(&self) -> &str {
            "test-model"
        }

        fn provider_name(&self) -> &str {
            "rate-limited-test"
        }
    }

    struct StaticContentProvider {
        content: &'static str,
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl LLMProvider for StaticContentProvider {
        async fn chat(
            &self,
            _messages: &[Value],
            _tools: Option<&[Value]>,
            _model: &str,
            _max_tokens: u32,
            _temperature: f32,
        ) -> Result<LLMResponse, ProviderError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(LLMResponse {
                content: Some(self.content.to_string()),
                tool_calls: Vec::new(),
                finish_reason: finish_reason::STOP.to_string(),
                usage: HashMap::new(),
                reasoning_content: None,
                blocks: Vec::new(),
                stream_error_kind: None,
                retry_after_ms: None,
            })
        }

        fn default_model(&self) -> &str {
            "test-model"
        }

        fn provider_name(&self) -> &str {
            "static-content-test"
        }
    }

    #[tokio::test]
    async fn capacity_error_abandons_batch_without_calling_provider_per_pending() {
        let conn = setup_conn();
        let scope = "agent:test";
        let first_id = learnings::insert_learning(&conn, &pending(scope, "first pending")).unwrap();
        let second_id =
            learnings::insert_learning(&conn, &pending(scope, "second pending")).unwrap();
        let third_id = learnings::insert_learning(&conn, &pending(scope, "third pending")).unwrap();
        let batch = learnings::load_pending_learnings(&conn, scope).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let ctx = BatchContext {
            scope,
            provider: Arc::new(RateLimitedProvider {
                calls: calls.clone(),
            }),
            model: "test-model".to_string(),
            mode: CandidateMode::Manifest,
            embed: None,
        };

        let counts = consolidate_batch(&conn, &ctx, batch).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            counts.added + counts.updated + counts.deleted + counts.none,
            0
        );
        assert_eq!(counts.abandoned, 3);
        assert!(learnings::load_pending_learnings(&conn, scope)
            .unwrap()
            .is_empty());
        for id in [first_id, second_id, third_id] {
            assert_eq!(
                learnings::load_learning_by_id(&conn, &id)
                    .unwrap()
                    .unwrap()
                    .status,
                LearningStatus::Abandoned
            );
        }
    }

    #[tokio::test]
    async fn parse_error_abandons_pending_row() {
        let conn = setup_conn();
        let scope = "agent:test";
        let pending_id =
            learnings::insert_learning(&conn, &pending(scope, "bad decision pending")).unwrap();
        let batch = learnings::load_pending_learnings(&conn, scope).unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let ctx = BatchContext {
            scope,
            provider: Arc::new(StaticContentProvider {
                content: "not-json",
                calls: calls.clone(),
            }),
            model: "test-model".to_string(),
            mode: CandidateMode::Manifest,
            embed: None,
        };

        let counts = consolidate_batch(&conn, &ctx, batch).await;

        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            counts.added + counts.updated + counts.deleted + counts.none,
            0
        );
        assert_eq!(counts.abandoned, 1);
        assert!(learnings::load_pending_learnings(&conn, scope)
            .unwrap()
            .is_empty());
        assert_eq!(
            learnings::load_learning_by_id(&conn, &pending_id)
                .unwrap()
                .unwrap()
                .status,
            LearningStatus::Abandoned
        );
    }
}
