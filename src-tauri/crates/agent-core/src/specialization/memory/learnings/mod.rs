//! Learning Store — persistent metacognitive insights in sessions.db.
//!
//! Learnings live in the shared `sessions.db` and represent cross-session behavioral insights:
//! "I should X when Y" rather than "user prefers Z".
//!
//! Schema (single table with status lifecycle):
//! - Structured storage: `content` (paragraph) + `takeaway` (one-line rule)
//! - Lifecycle: `status` ∈ { pending, active, merged, deprecated }
//! - Async write path metadata: `content_hash`, `reinforcement_count`, `source`, `account_id`
//! - Evolution DAG via `parent_id` (anti-loop enforced by chain depth walk)
//!
//! # Internal layout
//!
//! - **`types`** — `Learning` struct + `LearningCategory` / `EvolutionType` /
//!   `LearningStatus` / `LearningSource` enums.
//! - **`schema`** — `init_learnings_table` + `compute_content_hash` + the
//!   shared `SELECT_COLS` constant.
//! - **`crud`** — base writes/reads: `insert_learning`,
//!   `load_active_learnings`, `load_learning_by_id`, `row_to_learning`,
//!   plus the write-time `content_hash_dedup` guard.
//! - **`lifecycle`** — status transitions (`promote_pending_to_active`,
//!   `mark_merged`, `deprecate_learning`, `reactivate_learning`,
//!   `update_learning_body`, `delete_learning`, `touch_recall`) and the
//!   `consolidation_runs` ledger writes.
//! - **`stats`** — Browser/UI list and aggregate queries
//!   (`list_learnings`, `count_status_per_scope`, `latest_consolidation_run`).
//! - **`ranking`** — salience scoring + ranked retrieval
//!   (`load_active_learnings_ranked`, `search_similar`, `salience_score`,
//!   internal `AgeBucket` + age helpers).
//! - **`prompt`** — system-prompt rendering of ranked learnings
//!   (`format_learnings_for_prompt`, `inject_learnings_into_prompt`).
//!
//! Items kept at the `learnings::` surface — checked one by one against
//! real call sites. `touch_recall` is consumed only inside this module
//! (`prompt.rs` schedules it via `super::touch_recall`), and the prompt-
//! rendering helpers (`format_learnings_for_prompt`,
//! `load_active_learnings_ranked`) are likewise only reached through the
//! deeper `prompt::` / `ranking::` segment from `inject_learnings_into_prompt`,
//! so they don't need to be flattened here.

mod crud;
mod lifecycle;
mod prompt;
mod ranking;
mod schema;
mod stats;
mod types;

pub use crud::{
    content_hash_dedup, insert_learning, load_active_learnings, load_learning_by_id, DedupResult,
};
pub(crate) use lifecycle::touch_recall;
pub use lifecycle::{
    abandon_pending, count_pending_for_scope, count_pending_learnings, delete_learning,
    deprecate_learning, last_consolidation_at, load_active_candidates, load_pending_learnings,
    mark_merged, promote_pending_to_active, reactivate_learning, record_consolidation_run,
    update_learning_body, ConsolidationRunRecord,
};
pub use prompt::{
    inject_learnings_into_prompt, inject_learnings_into_prompt_reranked, learning_prompt_revision,
};
pub use ranking::{rerank_candidates, salience_score, search_similar};
pub use schema::{compute_content_hash, init_learnings_table};
pub use stats::{
    count_status_per_scope, latest_consolidation_run, list_learnings, LearningListFilter,
};
pub use types::{EvolutionType, Learning, LearningCategory, LearningSource, LearningStatus};

/// Default `agent_scope` when a Tauri caller omits it. Used by the
/// learnings browser endpoints (and the legacy `session_list_learnings`
/// HTTP debug shim) so that "no scope filter" is wire-stable across
/// call sites instead of every endpoint inlining the same string.
pub const GLOBAL_AGENT_SCOPE: &str = "_global";

/// Prefix for per-agent scopes. The reflection / active-learning write
/// paths build the scope as `format!("{}{}", AGENT_SCOPE_PREFIX, agent_id)`,
/// and the consolidator strips it back via `strip_prefix(AGENT_SCOPE_PREFIX)`.
/// Keep this single constant in sync with both directions.
pub const AGENT_SCOPE_PREFIX: &str = "agent:";

/// Build a per-agent scope key from an agent definition id.
///
/// `agent_id` is the `AgentDefinition::id` (e.g. `"builtin:sde"`). The
/// scope key wraps it as `agent:builtin:sde` so a single column can store
/// global rows (`GLOBAL_AGENT_SCOPE`), per-agent rows, and any future
/// scope dimensions without conflict.
pub fn scope_for_agent(agent_id: &str) -> String {
    format!("{}{}", AGENT_SCOPE_PREFIX, agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::specialization::memory::embeddings::cosine_similarity;
    use rusqlite::Connection;

    fn setup_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();
        conn
    }

    /// Helper — builds a minimally valid `Learning` for test callers.
    /// Pre-computes `content_hash` so tests stay realistic.
    fn make_learning(scope: &str, content: &str, category: LearningCategory) -> Learning {
        Learning {
            id: String::new(),
            agent_scope: scope.into(),
            content: content.into(),
            takeaway: None,
            category,
            importance: 0.5,
            confidence: 0.5,
            embedding: Vec::new(),
            embedding_model: None,
            status: LearningStatus::Active,
            content_hash: Some(compute_content_hash(content, category)),
            reinforcement_count: 1,
            source: LearningSource::Reflection,
            account_id: None,
            evolution_type: EvolutionType::Original,
            parent_id: None,
            last_recalled_at: None,
            source_session_id: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn insert_and_load_roundtrip() {
        let conn = setup_db();
        let mut learning = make_learning(
            "test-agent",
            "Always check error returns in Go",
            LearningCategory::Pattern,
        );
        learning.importance = 0.8;
        learning.confidence = 0.7;
        learning.embedding = vec![0.1, 0.2, 0.3];
        learning.source_session_id = Some("sess-1".into());

        let id = insert_learning(&conn, &learning).unwrap();
        let loaded = load_active_learnings(&conn, "test-agent").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].content, "Always check error returns in Go");
        assert_eq!(loaded[0].embedding.len(), 3);
        assert_eq!(loaded[0].status, LearningStatus::Active);
        assert!(loaded[0].content_hash.is_some());
        assert_eq!(loaded[0].reinforcement_count, 1);

        deprecate_learning(&conn, &id).unwrap();
        let active = load_active_learnings(&conn, "test-agent").unwrap();
        assert_eq!(
            active.len(),
            0,
            "deprecate should hide from load_active_learnings"
        );
    }

    #[test]
    fn pending_rows_visible_but_merged_hidden() {
        let conn = setup_db();

        let mut pending = make_learning("agent", "pending insight", LearningCategory::Pattern);
        pending.status = LearningStatus::Pending;
        insert_learning(&conn, &pending).unwrap();

        let mut merged = make_learning("agent", "merged insight", LearningCategory::Pattern);
        merged.status = LearningStatus::Merged;
        insert_learning(&conn, &merged).unwrap();

        let active = make_learning("agent", "active insight", LearningCategory::Pattern);
        insert_learning(&conn, &active).unwrap();

        let visible = load_active_learnings(&conn, "agent").unwrap();
        assert_eq!(visible.len(), 2, "pending + active visible, merged hidden");
        let contents: Vec<&str> = visible.iter().map(|l| l.content.as_str()).collect();
        assert!(contents.contains(&"pending insight"));
        assert!(contents.contains(&"active insight"));
        assert!(!contents.contains(&"merged insight"));
    }

    #[test]
    fn content_hash_stable_and_category_scoped() {
        let a = compute_content_hash("Always check error returns", LearningCategory::Pattern);
        let a2 = compute_content_hash(
            "  Always   check error returns  ",
            LearningCategory::Pattern,
        );
        let b = compute_content_hash("Always check error returns", LearningCategory::Correction);
        assert_eq!(a, a2, "whitespace normalization");
        assert_ne!(a, b, "category is part of the hash key");
        assert_eq!(a.len(), 16, "memU algorithm yields 16 hex chars");
    }

    #[test]
    fn test_cosine_similarity() {
        assert!((cosine_similarity(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 0.001);
        assert!((cosine_similarity(&[1.0, 0.0], &[0.0, 1.0])).abs() < 0.001);
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }

    #[test]
    fn hash_dedup_novel_when_empty() {
        let conn = setup_db();
        let result = content_hash_dedup(
            &conn,
            "agent-a",
            "prefers tabs over spaces",
            LearningCategory::Preference,
        )
        .unwrap();
        assert_eq!(result, DedupResult::Novel);
    }

    #[test]
    fn hash_dedup_reinforces_existing() {
        let conn = setup_db();
        let content = "Run tests before claiming done";
        let category = LearningCategory::Pattern;
        let row = make_learning("agent-a", content, category);
        let id = insert_learning(&conn, &row).unwrap();

        let r1 = content_hash_dedup(&conn, "agent-a", content, category).unwrap();
        assert_eq!(r1, DedupResult::Reinforced(id.clone()));

        let r2 = content_hash_dedup(&conn, "agent-a", content, category).unwrap();
        assert_eq!(r2, DedupResult::Reinforced(id.clone()));

        let loaded = load_learning_by_id(&conn, &id).unwrap().unwrap();
        assert_eq!(
            loaded.reinforcement_count, 3,
            "starts at 1, two dedup hits bumped it to 3"
        );
    }

    #[test]
    fn hash_dedup_ignores_deprecated_rows() {
        let conn = setup_db();
        let content = "Prefer explicit returns";
        let category = LearningCategory::Pattern;
        let row = make_learning("agent-a", content, category);
        let id = insert_learning(&conn, &row).unwrap();
        deprecate_learning(&conn, &id).unwrap();

        let result = content_hash_dedup(&conn, "agent-a", content, category).unwrap();
        assert_eq!(
            result,
            DedupResult::Novel,
            "deprecated rows are skipped by the guard"
        );
    }

    #[test]
    fn hash_dedup_scoped_by_agent() {
        let conn = setup_db();
        let content = "Use stable sort";
        let category = LearningCategory::Strategy;
        let row = make_learning("agent-a", content, category);
        insert_learning(&conn, &row).unwrap();

        let result_other = content_hash_dedup(&conn, "agent-b", content, category).unwrap();
        assert_eq!(
            result_other,
            DedupResult::Novel,
            "agent-b should not reinforce agent-a's row"
        );
    }

    /// Regression: a DB error on the dedup SELECT (e.g. schema missing,
    /// transient lock contention) used to be silently collapsed to
    /// `Ok(Novel)` by `.ok()`, letting the caller proceed to insert a
    /// duplicate row. It now propagates as `Err` so the caller can
    /// decide whether to retry or skip.
    #[test]
    fn hash_dedup_db_error_propagates() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        // No `learnings` table — SELECT will fail with a "no such table" error.
        let err = content_hash_dedup(
            &conn,
            "agent-a",
            "this should never reach insert",
            LearningCategory::Pattern,
        )
        .expect_err("missing schema must propagate as Err, not Ok(Novel)");
        let msg = err.to_string();
        assert!(
            msg.contains("no such table") || msg.contains("learnings"),
            "expected sqlite \"no such table\" error, got: {msg}"
        );
    }
}
