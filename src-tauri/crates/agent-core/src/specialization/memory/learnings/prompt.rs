//! Prompt-section rendering for L3 learnings.
//!
//! Consumes a `Vec<Learning>` produced by `ranking::load_active_learnings_ranked`
//! and renders the three-tier ("Recent / Medium / Older") layout, then enforces
//! line + byte caps so a single noisy scope can't dominate the system prompt.
//!
//! `inject_learnings_into_prompt` is the high-level entry point — it loads,
//! ranks, renders, and schedules a fire-and-forget `touch_recall` for every
//! injected learning so its `last_recalled_at` stays fresh.

use rusqlite::params;
use tracing::warn;

use super::ranking::{age_days_since_last_touch, load_active_learnings_ranked, AgeBucket};
use super::{Learning, LearningCategory, LearningStatus};

/// Cap on total lines emitted by the prompt section. Tighter than the L2
/// entrypoint memory caps (200 / 25_000) because L3 lives alongside L2.
const MAX_L3_LINES: usize = 120;

/// Cap on total bytes emitted by the prompt section (incl. headers).
const MAX_L3_BYTES: usize = 20_000;

/// Human-readable age string. Past 30 days we flag as "may be outdated";
/// past a year as "likely stale" — the system prompt receives the
/// annotation verbatim so the LLM can discount aged advice rather than
/// treating it as ground truth.
fn freshness_text(age_days: i64) -> String {
    match age_days {
        0 => "today".into(),
        1 => "1 day ago".into(),
        d if d <= 29 => format!("{d} days ago"),
        d if d <= 364 => format!("{} months ago — may be outdated", d / 30),
        d => format!("{} years ago — likely stale", d / 365),
    }
}

/// Reinforcement tag (only emitted once ≥ 2 — a single-sighting learning
/// doesn't need "(reinforced ×1)" noise in every prompt).
fn reinforcement_tag(count: u32) -> String {
    if count >= 2 {
        format!(", reinforced ×{count}")
    } else {
        String::new()
    }
}

/// Trim the prompt until both the line cap (`MAX_L3_LINES`) and the byte
/// cap (`MAX_L3_BYTES`) are satisfied. Called on the *formatted* output so
/// header + trailer lines are counted honestly. We drop from the bottom —
/// callers sort by salience descending, so the lowest-scored items go first.
fn enforce_caps(text: String) -> String {
    if text.len() <= MAX_L3_BYTES && text.lines().count() <= MAX_L3_LINES {
        return text;
    }
    let mut lines: Vec<&str> = text.lines().collect();
    while (lines.len() > MAX_L3_LINES
        || lines.iter().map(|l| l.len() + 1).sum::<usize>() > MAX_L3_BYTES)
        && !lines.is_empty()
    {
        lines.pop();
    }
    let mut trimmed = lines.join("\n");
    trimmed.push('\n');
    trimmed
}

/// First line of `content` — cheap fallback when a learning doesn't yet
/// have a `takeaway` stored. Medium/Old buckets prefer takeaways because
/// they compress better, but we don't want to silently drop content.
fn compressed_line(l: &Learning) -> String {
    l.takeaway
        .as_deref()
        .map(str::to_string)
        .unwrap_or_else(|| l.content.lines().next().unwrap_or(&l.content).to_string())
}

fn is_pending(l: &Learning) -> bool {
    matches!(l.status, LearningStatus::Pending)
}

/// Three-tier render matching the plan §4.2 layout. `Recent` keeps full
/// content + recency + reinforcement tag; `Medium` compresses to
/// `takeaway`; `Old` groups by `category` with a theme header — this is
/// the same layout `yoyo-evolve/memory/active_learnings.md` uses.
///
/// Pending rows of any age get an extra `(pending consolidation)` tag and
/// render with full content regardless of bucket, so the agent can tell
/// "fact from this session, not yet consolidated" apart from
/// "fact we've reinforced across sessions".
pub fn format_learnings_for_prompt(learnings: &[Learning]) -> String {
    if learnings.is_empty() {
        return String::new();
    }

    let mut recent: Vec<&Learning> = Vec::new();
    let mut medium: Vec<&Learning> = Vec::new();
    let mut old: Vec<&Learning> = Vec::new();

    for l in learnings {
        let age = age_days_since_last_touch(l);
        match AgeBucket::from_age_days(age) {
            AgeBucket::Recent => recent.push(l),
            AgeBucket::Medium => medium.push(l),
            AgeBucket::Old => old.push(l),
        }
    }

    let mut out = String::from(
        "\n## Learned Insights\n\nInsights from previous sessions. Apply them when relevant; an \"outdated\" or \"stale\" tag means the fact may no longer hold.\n\n",
    );

    if !recent.is_empty() {
        out.push_str("### Recent (last 7 days)\n\n");
        for (i, l) in recent.iter().enumerate() {
            let age = age_days_since_last_touch(l);
            let pending_tag = if is_pending(l) {
                " (pending consolidation)"
            } else {
                ""
            };
            out.push_str(&format!(
                "{}. [{}]{} ({}{}, confidence {:.0}%) {}\n",
                i + 1,
                l.category.as_str(),
                pending_tag,
                freshness_text(age),
                reinforcement_tag(l.reinforcement_count),
                l.confidence * 100.0,
                l.content
            ));
        }
        out.push('\n');
    }

    if !medium.is_empty() {
        out.push_str("### Medium (8–30 days, condensed)\n\n");
        for (i, l) in medium.iter().enumerate() {
            let age = age_days_since_last_touch(l);
            let pending_tag = if is_pending(l) {
                " (pending consolidation)"
            } else {
                ""
            };
            let body = if is_pending(l) {
                l.content.clone()
            } else {
                compressed_line(l)
            };
            out.push_str(&format!(
                "{}. [{}]{} ({}{}) {}\n",
                i + 1,
                l.category.as_str(),
                pending_tag,
                freshness_text(age),
                reinforcement_tag(l.reinforcement_count),
                body
            ));
        }
        out.push('\n');
    }

    if !old.is_empty() {
        out.push_str("### Older (30+ days, themed)\n\n");
        let mut groups: std::collections::BTreeMap<LearningCategory, Vec<&Learning>> =
            std::collections::BTreeMap::new();
        for l in &old {
            groups.entry(l.category).or_default().push(l);
        }
        for (category, items) in groups {
            out.push_str(&format!("**{}:**\n", category.as_str()));
            for l in items {
                let age = age_days_since_last_touch(l);
                let pending_tag = if is_pending(l) {
                    " (pending consolidation)"
                } else {
                    ""
                };
                let body = if is_pending(l) {
                    l.content.clone()
                } else {
                    compressed_line(l)
                };
                out.push_str(&format!(
                    "- {}{} ({}) {}\n",
                    body,
                    pending_tag,
                    freshness_text(age),
                    reinforcement_tag(l.reinforcement_count).trim_start_matches(", "),
                ));
            }
            out.push('\n');
        }
    }

    enforce_caps(out)
}

pub fn learning_prompt_revision(agent_scope: &str) -> Option<(u64, Option<String>)> {
    use sha2::{Digest, Sha256};

    let conn = crate::foundation::db_bridge::get_connection().ok()?;
    let mut stmt = conn
        .prepare(
            "SELECT id, content_hash, COALESCE(takeaway, ''), category, status,
                    importance, confidence, reinforcement_count, evolution_type,
                    COALESCE(parent_id, '')
             FROM learnings
             WHERE agent_scope = ?1
               AND status NOT IN ('merged', 'deprecated', 'abandoned')
             ORDER BY id",
        )
        .ok()?;
    let rows = stmt
        .query_map(params![agent_scope], |row| {
            let id: String = row.get(0)?;
            let content_hash: Option<String> = row.get(1)?;
            let takeaway: String = row.get(2)?;
            let category: String = row.get(3)?;
            let status: String = row.get(4)?;
            let importance: f64 = row.get(5)?;
            let confidence: f64 = row.get(6)?;
            let reinforcement_count: i64 = row.get(7)?;
            let evolution_type: String = row.get(8)?;
            let parent_id: String = row.get(9)?;
            Ok(format!(
                "{id}\u{1f}{hash}\u{1f}{takeaway}\u{1f}{category}\u{1f}{status}\u{1f}{importance:.6}\u{1f}{confidence:.6}\u{1f}{reinforcement_count}\u{1f}{evolution_type}\u{1f}{parent_id}",
                hash = content_hash.unwrap_or_default()
            ))
        })
        .ok()?;

    let mut count = 0_u64;
    let mut hasher = Sha256::new();
    for row in rows {
        let row = row.ok()?;
        count += 1;
        hasher.update(row.as_bytes());
        hasher.update(b"\n");
    }
    let digest = hasher.finalize();
    Some((count, Some(format!("{:x}", digest))))
}

/// Load, rank, render — and schedule an async `touch_recall` for each
/// injected learning so its `last_recalled_at` stays fresh. The spawn is
/// fire-and-forget: we never block the prompt build on a DB write, and
/// failures only warn.
///
/// When `query_embedding` is provided and learnings have stored embeddings,
/// the retrieval uses cosine-similarity top-K search (semantic retrieval)
/// instead of the salience-score ranking. This injects only the learnings
/// that are most relevant to the current user task, reducing prompt size and
/// improving signal-to-noise ratio for long-running sessions.
///
/// Falls back to salience-score ranking when:
/// - `query_embedding` is `None`
/// - No learnings have stored embeddings (legacy rows without embeddings)
/// - `search_similar` returns fewer than 2 results
pub fn inject_learnings_into_prompt(agent_scope: &str, query_embedding: Option<&[f32]>) -> String {
    let Ok(conn) = crate::foundation::db_bridge::get_connection() else {
        return String::new();
    };

    // Minimum cosine similarity for a learning to be considered relevant.
    const MIN_SEMANTIC_SIMILARITY: f32 = 0.30;
    // Top-K results to retrieve via semantic search.
    const SEMANTIC_TOP_K: usize = 12;

    let ranked = if let Some(embedding) = query_embedding {
        match super::ranking::search_similar(
            &conn,
            agent_scope,
            embedding,
            None,
            SEMANTIC_TOP_K,
            MIN_SEMANTIC_SIMILARITY,
        ) {
            Ok(pairs) if pairs.len() >= 2 => pairs.into_iter().map(|(l, _)| l).collect::<Vec<_>>(),
            Ok(_) => {
                // Too few semantic hits — fall back to salience ranking.
                match load_active_learnings_ranked(&conn, agent_scope) {
                    Ok(r) => r,
                    Err(err) => {
                        warn!("[learnings] load_active_learnings_ranked fallback failed: {err}");
                        return String::new();
                    }
                }
            }
            Err(err) => {
                warn!("[learnings] search_similar failed: {err}; falling back to salience ranking");
                match load_active_learnings_ranked(&conn, agent_scope) {
                    Ok(r) => r,
                    Err(err2) => {
                        warn!("[learnings] load_active_learnings_ranked fallback failed: {err2}");
                        return String::new();
                    }
                }
            }
        }
    } else {
        match load_active_learnings_ranked(&conn, agent_scope) {
            Ok(r) => r,
            Err(err) => {
                warn!("[learnings] load_active_learnings_ranked failed: {err}");
                return String::new();
            }
        }
    };

    if ranked.is_empty() {
        return String::new();
    }

    let ids: Vec<String> = ranked.iter().map(|l| l.id.clone()).collect();
    schedule_touch_recall(ids);

    format_learnings_for_prompt(&ranked)
}

/// Async, query-aware variant of [`inject_learnings_into_prompt`].
///
/// Where the sync entry point only has a `query_embedding` (or nothing) and
/// must run inside the synchronous system-prompt builder, this variant runs
/// in async call sites that *do* have the raw task text — notably the
/// orchestration `agent` tool, where the worker's `prompt` argument is the
/// task. Having the raw query text unlocks the cross-encoder reranker
/// (`search_similar_reranked`), which cosine alone can't use.
///
/// Pipeline:
/// 1. Embed `query_text` via the workspace `AutoEmbeddingProvider`
///    (provider/model from `IntegrationsConfig.embedding`).
/// 2. Cosine coarse-recall + cross-encoder rerank (`search_similar_reranked`).
/// 3. Fall back to salience ranking when embedding is unavailable or the
///    semantic pass yields < 2 hits — identical degradation contract to the
///    sync path, so callers never lose learnings injection.
pub async fn inject_learnings_into_prompt_reranked(agent_scope: &str, query_text: &str) -> String {
    use crate::specialization::memory::embeddings::{AutoEmbeddingProvider, EmbeddingProvider};

    const MIN_SEMANTIC_SIMILARITY: f32 = 0.30;
    const SEMANTIC_TOP_K: usize = 12;

    // Empty / whitespace task → no meaningful query; fall straight back to
    // salience ranking (no point embedding an empty string).
    let trimmed = query_text.trim();
    if trimmed.is_empty() {
        return inject_learnings_into_prompt(agent_scope, None);
    }

    // Resolve the workspace embedding provider (same config the memory-search
    // tools and consolidation use).
    let embed_cfg = crate::state::integrations_store::integrations_store()
        .snapshot()
        .embedding;
    let provider = AutoEmbeddingProvider::new(embed_cfg.provider, embed_cfg.model);

    let (query_embedding, query_model) = match provider.embed(trimmed).await {
        Ok(res) => (res.vector, Some(res.model)),
        Err(err) => {
            warn!(
                "[learnings] query embed failed ({err}); falling back to salience ranking"
            );
            return inject_learnings_into_prompt(agent_scope, None);
        }
    };

    // Stage 1 (sync, DB): cosine coarse-recall. The `rusqlite::Connection`
    // is `!Sync` and MUST NOT be held across the rerank `.await`, so we do
    // all DB work inside this block and let `conn` drop before awaiting.
    let coarse = {
        let Ok(conn) = crate::foundation::db_bridge::get_connection() else {
            return String::new();
        };
        match super::ranking::search_similar(
            &conn,
            agent_scope,
            &query_embedding,
            query_model.as_deref(),
            SEMANTIC_TOP_K.saturating_mul(super::ranking::RERANK_RECALL_MULT),
            MIN_SEMANTIC_SIMILARITY,
        ) {
            Ok(pairs) => pairs,
            Err(err) => {
                warn!("[learnings] cosine recall failed: {err}; salience fallback");
                return inject_learnings_into_prompt(agent_scope, None);
            }
        }
    };

    // Stage 2 (async, DB-free): cross-encoder rerank over the recalled pool.
    let ranked_pairs = super::ranking::rerank_candidates(trimmed, coarse, SEMANTIC_TOP_K).await;

    let ranked: Vec<Learning> = if ranked_pairs.len() >= 2 {
        ranked_pairs.into_iter().map(|(l, _)| l).collect()
    } else {
        // Too few semantic hits — salience fallback (re-opens its own conn).
        return inject_learnings_into_prompt(agent_scope, None);
    };

    if ranked.is_empty() {
        return String::new();
    }

    let ids: Vec<String> = ranked.iter().map(|l| l.id.clone()).collect();
    schedule_touch_recall(ids);

    format_learnings_for_prompt(&ranked)
}
/// tokio runtime when one is available; otherwise falls back to a detached
/// OS thread. Either way the caller returns immediately — the prompt
/// builder never waits on a DB write.
fn schedule_touch_recall(ids: Vec<String>) {
    let task = move || {
        let conn = match crate::foundation::db_bridge::get_connection() {
            Ok(c) => c,
            Err(err) => {
                warn!("[learnings] touch_recall: get_connection failed: {err}");
                return;
            }
        };
        for id in &ids {
            if let Err(err) = super::touch_recall(&conn, id) {
                warn!("[learnings] touch_recall({id}) failed: {err}");
            }
        }
    };

    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn_blocking(task);
        }
        Err(_) => {
            std::thread::spawn(task);
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use rusqlite::Connection;

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
    fn test_format_learnings_empty() {
        assert!(format_learnings_for_prompt(&[]).is_empty());
    }

    #[test]
    fn test_format_learnings_single() {
        let learnings = vec![make_learning("Always use structured logging", 0.8, 0.9)];
        let result = format_learnings_for_prompt(&learnings);
        assert!(result.contains("Learned Insights"));
        assert!(result.contains("structured logging"));
        assert!(result.contains("90%"));
    }

    #[test]
    fn test_format_learnings_multiple_categories() {
        let mut correction = make_learning("Never swallow errors silently", 0.9, 0.85);
        correction.category = LearningCategory::Correction;
        let mut strategy = make_learning("Use batch inserts for >100 rows", 0.7, 0.6);
        strategy.category = LearningCategory::Strategy;

        let result = format_learnings_for_prompt(&[correction, strategy]);
        assert!(result.contains("[correction]"));
        assert!(result.contains("[strategy]"));
        assert!(result.contains("1."));
        assert!(result.contains("2."));
    }

    #[test]
    fn test_inject_learnings_no_db() {
        let result = inject_learnings_into_prompt("agent:nonexistent", None);
        assert!(result.is_empty() || result.contains("Learned Insights"));
    }

    #[test]
    fn test_freshness_text_ladder() {
        assert_eq!(freshness_text(0), "today");
        assert_eq!(freshness_text(1), "1 day ago");
        assert_eq!(freshness_text(15), "15 days ago");
        assert!(freshness_text(45).contains("months ago"));
        assert!(freshness_text(45).contains("outdated"));
        assert!(freshness_text(400).contains("years ago"));
        assert!(freshness_text(400).contains("stale"));
    }

    #[test]
    fn test_reinforcement_tag_threshold() {
        assert_eq!(reinforcement_tag(1), "");
        assert_eq!(reinforcement_tag(2), ", reinforced ×2");
        assert_eq!(reinforcement_tag(17), ", reinforced ×17");
    }

    #[test]
    fn test_format_three_buckets_appear() {
        let recent = make_dated_learning("recent fact", 0.8, 0.9, 1, 2, None);
        let medium = make_dated_learning("medium fact", 0.8, 0.9, 3, 15, None);
        let old = make_dated_learning("old fact", 0.8, 0.9, 5, 120, None);

        let rendered = format_learnings_for_prompt(&[recent, medium, old]);
        assert!(rendered.contains("Recent (last 7 days)"));
        assert!(rendered.contains("Medium (8–30 days"));
        assert!(rendered.contains("Older (30+ days"));
        assert!(rendered.contains("recent fact"));
        assert!(rendered.contains("medium fact"));
        assert!(rendered.contains("old fact"));
    }

    #[test]
    fn test_pending_learnings_tagged_and_full_content() {
        let mut pending = make_dated_learning(
            "multi-line pending content with lots of detail",
            0.7,
            0.8,
            1,
            20,
            None,
        );
        pending.status = LearningStatus::Pending;
        pending.takeaway = Some("short takeaway".into());

        let rendered = format_learnings_for_prompt(&[pending]);
        assert!(rendered.contains("(pending consolidation)"));
        assert!(rendered.contains("multi-line pending content with lots of detail"));
    }

    #[test]
    fn test_format_no_reinforcement_tag_when_one() {
        let l = make_dated_learning("single-sight fact", 0.8, 0.9, 1, 1, None);
        let rendered = format_learnings_for_prompt(&[l]);
        assert!(!rendered.contains("reinforced ×1"));
    }

    #[test]
    fn test_format_includes_reinforcement_tag_when_many() {
        let l = make_dated_learning("heavy fact", 0.8, 0.9, 5, 1, None);
        let rendered = format_learnings_for_prompt(&[l]);
        assert!(rendered.contains("reinforced ×5"));
    }

    #[test]
    fn test_medium_bucket_uses_takeaway() {
        let mut l = make_dated_learning(
            "long form content line 1\nline 2 should not appear",
            0.8,
            0.9,
            2,
            15,
            None,
        );
        l.takeaway = Some("compressed takeaway".into());
        let rendered = format_learnings_for_prompt(&[l]);
        assert!(rendered.contains("compressed takeaway"));
        assert!(!rendered.contains("line 2 should not appear"));
    }

    #[test]
    fn test_enforce_caps_trims_bytes() {
        let mut text = String::from("## Learned Insights\n\n");
        for i in 0..2000 {
            text.push_str(&format!("line {} with some padding to burn bytes\n", i));
        }
        let trimmed = enforce_caps(text);
        assert!(trimmed.len() <= MAX_L3_BYTES);
        assert!(trimmed.lines().count() <= MAX_L3_LINES);
    }

    #[test]
    fn test_enforce_caps_passthrough_when_small() {
        let text = "## Learned Insights\n\nonly one line\n".to_string();
        let out = enforce_caps(text.clone());
        assert_eq!(out.trim_end(), text.trim_end());
    }

    #[test]
    fn test_touch_recall_updates_last_recalled_at() {
        use super::super::{load_learning_by_id, touch_recall};
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();

        let learning = make_learning("some insight", 0.8, 0.9);
        let id = insert_learning(&conn, &learning).unwrap();

        let before = load_learning_by_id(&conn, &id).unwrap().unwrap();
        assert!(before.last_recalled_at.is_none());

        touch_recall(&conn, &id).unwrap();

        let after = load_learning_by_id(&conn, &id).unwrap().unwrap();
        assert!(after.last_recalled_at.is_some());
    }

    #[test]
    fn test_touch_recall_skips_deprecated() {
        use super::super::{deprecate_learning, load_learning_by_id, touch_recall};
        let conn = Connection::open_in_memory().unwrap();
        init_learnings_table(&conn).unwrap();

        let learning = make_learning("deprecated insight", 0.8, 0.9);
        let id = insert_learning(&conn, &learning).unwrap();
        deprecate_learning(&conn, &id).unwrap();

        touch_recall(&conn, &id).unwrap();

        let after = load_learning_by_id(&conn, &id).unwrap().unwrap();
        assert!(after.last_recalled_at.is_none());
    }
}
