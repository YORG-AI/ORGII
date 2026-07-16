//! Salience scoring + ranked retrieval.
//!
//! Pure-data layer over `crud`/`lifecycle` queries: produces a `Vec<Learning>`
//! sorted by salience (`load_active_learnings_ranked`) or cosine similarity
//! (`search_similar`). Rendering and prompt-cap enforcement live in
//! `prompt.rs`.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, Result as SqliteResult};

use super::super::embeddings::cosine_similarity;
use super::{load_active_candidates, load_active_learnings, Learning};

/// Maximum learnings to inject into a system prompt (pre-cap; the byte/line
/// caps in §4.3 may trim further).
pub(super) const MAX_ACTIVE_LEARNINGS: usize = 15;

/// Half-life for time decay (days). A learning whose last touch is 14 days
/// in the past has ~50 % of the recency weight of one touched today.
const DECAY_HALF_LIFE_DAYS: f64 = 14.0;

/// Age bucket used for three-tier rendering. The boundaries are exclusive
/// on the upper end — a 7-day-old learning is still `Recent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum AgeBucket {
    /// 0–7 days. Rendered with full `content`.
    Recent,
    /// 8–30 days. Rendered `takeaway`-only (or first line of `content`
    /// when no takeaway is stored).
    Medium,
    /// 31+ days. Grouped by `category`, one header + takeaway bullets.
    Old,
}

impl AgeBucket {
    pub(super) fn from_age_days(age_days: i64) -> Self {
        match age_days {
            x if x <= 7 => Self::Recent,
            x if x <= 30 => Self::Medium,
            _ => Self::Old,
        }
    }
}

/// Number of days since the learning was last "touched" (recalled or
/// created). `last_recalled_at` beats `created_at` when present so
/// frequently-injected learnings resist time decay. On parse failure we
/// fall back to 30 days — treat as medium-old, never negative.
pub(super) fn age_days_since_last_touch(l: &Learning) -> i64 {
    let now = Utc::now();
    let ts = l.last_recalled_at.as_deref().unwrap_or(&l.created_at);
    match DateTime::parse_from_rfc3339(ts) {
        Ok(dt) => (now - dt.with_timezone(&Utc)).num_days().max(0),
        Err(err) => {
            tracing::warn!(
                learning_id = %l.id,
                ts = %ts,
                error = %err,
                "[learnings] malformed timestamp in age_days_since_last_touch; treating as 30d-old"
            );
            30
        }
    }
}

/// Floating-point variant used by the decay formula (keeps sub-day
/// granularity so freshly-touched learnings stay distinguishable).
fn age_days_f64(l: &Learning) -> f64 {
    let now = Utc::now();
    let ts = l.last_recalled_at.as_deref().unwrap_or(&l.created_at);
    match DateTime::parse_from_rfc3339(ts) {
        Ok(dt) => ((now - dt.with_timezone(&Utc)).num_hours() as f64 / 24.0).max(0.0),
        Err(err) => {
            tracing::warn!(
                learning_id = %l.id,
                ts = %ts,
                error = %err,
                "[learnings] malformed timestamp in age_days_f64; treating as 30d-old"
            );
            30.0
        }
    }
}

/// memU-style salience score:
///
/// ```text
/// score = importance × confidence × ln(reinforcement + 1) × time_decay
/// time_decay = exp(ln(0.5) × age_days / half_life)
/// ```
///
/// `ln(count + 1)` grows sub-linearly so a 10× reinforced learning is ~3.5×
/// stronger than a fresh one (0.69 → 2.40), without letting one noisy
/// category drown out everything else. Age counts from `last_recalled_at`
/// when present — touching a learning via injection resets its decay clock.
pub fn salience_score(l: &Learning) -> f64 {
    let ln_half = (0.5_f64).ln();
    let reinforcement = ((l.reinforcement_count as f64) + 1.0).ln();
    let time_decay = (ln_half * age_days_f64(l) / DECAY_HALF_LIFE_DAYS).exp();
    l.importance * l.confidence * reinforcement * time_decay
}

/// Load every non-deprecated learning for `agent_scope` (including
/// `pending`), score with `salience_score`, sort descending, take the
/// top `MAX_ACTIVE_LEARNINGS`.
///
/// Pending rows are intentionally included — a learning extracted during
/// the current session is useful to the next one immediately, before
/// consolidation has had a chance to run. They're tagged at render time
/// (`(pending consolidation)`) so the agent can weigh them accordingly.
pub fn load_active_learnings_ranked(
    conn: &Connection,
    agent_scope: &str,
) -> SqliteResult<Vec<Learning>> {
    let all = load_active_learnings(conn, agent_scope)?;
    if all.is_empty() {
        return Ok(all);
    }

    let mut scored: Vec<(f64, usize)> = all
        .iter()
        .enumerate()
        .map(|(idx, l)| (salience_score(l), idx))
        .collect();

    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(MAX_ACTIVE_LEARNINGS);

    let ranked: Vec<Learning> = scored
        .into_iter()
        .map(|(_, idx)| all[idx].clone())
        .collect();
    Ok(ranked)
}

/// Vector similarity search against stored learnings.
/// Returns (learning, cosine_similarity) pairs sorted by similarity desc.
///
/// Only compares embeddings generated by the same model (embedding_model must match).
/// Learnings without embeddings or with a different model are skipped.
///
/// Candidate pool is `status='active'` only (`load_active_candidates`). We
/// deliberately do NOT use `load_active_learnings` here — that loader
/// includes `pending` rows, which is correct for the prompt injection read
/// path (fresh insights should show up immediately) but catastrophically
/// wrong for the consolidation write path: a pending row that finds itself
/// as its own "similar neighbour" produces a self-UPDATE/MERGE and the
/// entire pending batch collapses into `merged` status, never reaching
/// `active`. See `docs/agent/audit-fallbacks-0421.md` for the
/// 14 polluted rows this caused on `agent:builtin:sde` before 0421.
pub fn search_similar(
    conn: &Connection,
    agent_scope: &str,
    query_embedding: &[f32],
    query_embedding_model: Option<&str>,
    top_k: usize,
    min_similarity: f32,
) -> SqliteResult<Vec<(Learning, f32)>> {
    let all = load_active_candidates(conn, agent_scope)?;
    let query_dims = query_embedding.len();

    let mut scored: Vec<(Learning, f32)> = all
        .into_iter()
        .filter(|l| {
            // Skip empty embeddings
            if l.embedding.is_empty() {
                return false;
            }
            // Skip dimension mismatch (different model families)
            if l.embedding.len() != query_dims {
                return false;
            }
            // If we know our model, only compare against same model
            if let Some(qm) = query_embedding_model {
                match &l.embedding_model {
                    Some(lm) if lm == qm => true,
                    Some(_) => false,
                    // Legacy learnings without model tag — allow comparison if dims match
                    None => true,
                }
            } else {
                true
            }
        })
        .map(|l| {
            let sim = cosine_similarity(query_embedding, &l.embedding);
            (l, sim)
        })
        .filter(|(_, sim)| *sim >= min_similarity)
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(top_k);
    Ok(scored)
}

/// Cross-encoder rerank over an already-recalled candidate pool.
///
/// ORG-2 upstream only had cosine. The added increment (Simon's setup) is a
/// local Qwen3 reranker at `http://localhost:9877`: cosine is fast but
/// bag-of-meaning; the cross-encoder reads `(query, learning)` jointly and
/// reorders by true relevance, which matters most when several learnings
/// share surface vocabulary but differ in applicability.
///
/// `coarse` MUST come from a prior cosine recall (e.g. `search_similar` with
/// a widened `top_k`). This function is intentionally DB-free so the caller
/// can drop its `rusqlite::Connection` borrow before awaiting — `Connection`
/// is `!Sync` and cannot be held across an `.await`.
///
/// Best-effort: if the reranker is unreachable or errors, the cosine order
/// (truncated to `top_k`) is returned. Retrieval never fails on rerank.
pub async fn rerank_candidates(
    query_text: &str,
    coarse: Vec<(Learning, f32)>,
    top_k: usize,
) -> Vec<(Learning, f32)> {
    // Nothing to rerank, or so few hits the reranker can't improve order.
    if coarse.len() <= 1 {
        let mut out = coarse;
        out.truncate(top_k);
        return out;
    }

    let documents: Vec<String> = coarse.iter().map(|(l, _)| l.content.clone()).collect();
    let reranker = super::super::embeddings::LocalReranker::new();
    match reranker.rerank(query_text, &documents, top_k).await {
        Ok(ranked) if !ranked.is_empty() => ranked
            .into_iter()
            .filter_map(|(idx, score)| coarse.get(idx).map(|(l, _)| (l.clone(), score)))
            .collect(),
        Ok(_) => {
            let mut out = coarse;
            out.truncate(top_k);
            out
        }
        Err(err) => {
            tracing::warn!("[learnings] rerank failed ({err}); falling back to cosine order");
            let mut out = coarse;
            out.truncate(top_k);
            out
        }
    }
}

/// Coarse-recall multiplier: cosine retrieves `top_k * RERANK_RECALL_MULT`
/// candidates, the cross-encoder reranker then picks the final `top_k`.
/// 3× gives the reranker enough breadth to surface a learning that cosine
/// ranked just below the cut without blowing up the rerank payload.
pub(super) const RERANK_RECALL_MULT: usize = 3;

#[cfg(test)]
mod tests {
    use super::super::{
        compute_content_hash, init_learnings_table, insert_learning, EvolutionType,
        LearningCategory, LearningSource, LearningStatus,
    };
    use super::*;

    fn make_learning(content: &str, importance: f64, confidence: f64) -> Learning {
        let category = LearningCategory::Pattern;
        Learning {
            id: String::new(),
            agent_scope: "agent:test".into(),
            content: content.into(),
            takeaway: None,
            category,
            importance,
            confidence,
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
            source_session_id: Some("test-session".into()),
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        }
    }

    fn make_dated_learning(
        content: &str,
        importance: f64,
        confidence: f64,
        reinforcement: u32,
        age_days: i64,
        last_recall_age_days: Option<i64>,
    ) -> Learning {
        let mut l = make_learning(content, importance, confidence);
        l.reinforcement_count = reinforcement;
        let created = Utc::now() - chrono::Duration::days(age_days);
        l.created_at = created.to_rfc3339();
        l.updated_at = created.to_rfc3339();
        l.last_recalled_at =
            last_recall_age_days.map(|d| (Utc::now() - chrono::Duration::days(d)).to_rfc3339());
        l
    }

    #[test]
    fn test_load_ranked_respects_max() {
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();

        for idx in 0..20 {
            let learning =
                make_learning(&format!("Insight {}", idx), 0.5 + (idx as f64) * 0.02, 0.8);
            insert_learning(&conn, &learning).unwrap();
        }

        let ranked = load_active_learnings_ranked(&conn, "agent:test").unwrap();
        assert!(ranked.len() <= MAX_ACTIVE_LEARNINGS);
    }

    #[test]
    fn test_load_ranked_empty_scope() {
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();
        let ranked = load_active_learnings_ranked(&conn, "agent:nonexistent").unwrap();
        assert!(ranked.is_empty());
    }

    #[test]
    fn test_load_ranked_order_by_score() {
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();

        let low = make_learning("Low score", 0.1, 0.1);
        let high = make_learning("High score", 1.0, 1.0);
        insert_learning(&conn, &low).unwrap();
        insert_learning(&conn, &high).unwrap();

        let ranked = load_active_learnings_ranked(&conn, "agent:test").unwrap();
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].content, "High score");
        assert_eq!(ranked[1].content, "Low score");
    }

    #[test]
    fn test_salience_score_monotonic_in_reinforcement() {
        let fresh = make_dated_learning("a", 0.5, 0.5, 1, 3, None);
        let reinforced = make_dated_learning("a", 0.5, 0.5, 10, 3, None);
        assert!(salience_score(&reinforced) > salience_score(&fresh));
    }

    #[test]
    fn test_salience_score_last_recalled_beats_created_age() {
        let stale = make_dated_learning("stale", 0.5, 0.5, 1, 60, None);
        let refreshed = make_dated_learning("refreshed", 0.5, 0.5, 1, 60, Some(1));
        assert!(salience_score(&refreshed) > salience_score(&stale));
    }

    #[test]
    fn test_age_bucket_boundaries() {
        assert_eq!(AgeBucket::from_age_days(0), AgeBucket::Recent);
        assert_eq!(AgeBucket::from_age_days(7), AgeBucket::Recent);
        assert_eq!(AgeBucket::from_age_days(8), AgeBucket::Medium);
        assert_eq!(AgeBucket::from_age_days(30), AgeBucket::Medium);
        assert_eq!(AgeBucket::from_age_days(31), AgeBucket::Old);
        assert_eq!(AgeBucket::from_age_days(400), AgeBucket::Old);
    }

    #[test]
    fn test_ranking_includes_pending_rows() {
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();

        let mut pending = make_learning("pending insight", 0.9, 0.9);
        pending.status = LearningStatus::Pending;
        let active = make_learning("active insight", 0.9, 0.9);
        insert_learning(&conn, &pending).unwrap();
        insert_learning(&conn, &active).unwrap();

        let ranked = load_active_learnings_ranked(&conn, "agent:test").unwrap();
        assert_eq!(ranked.len(), 2);
        let has_pending = ranked
            .iter()
            .any(|l| matches!(l.status, LearningStatus::Pending));
        assert!(has_pending);
    }
}
