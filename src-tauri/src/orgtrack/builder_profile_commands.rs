//! Tauri commands for the Builder Profile (chat pane → Runtime → Profile).
//!
//! Thin wrappers over [`orgtrack_core::profile`]. Reads the cached
//! `orgtrack_core_session_signals` projection and scores it; it never parses a
//! transcript on the request path. Filling that projection is the job of
//! [`builder_profile_extract`], which the panel calls in bounded batches so a
//! first-time profile fills in visibly instead of blocking on tens of thousands
//! of transcripts.

use std::sync::OnceLock;

use database::db::get_connection;
use orgtrack_core::profile::{
    self,
    highlights::{self, Highlight},
    store::{self as signal_store, Coverage},
    BuilderProfile, SessionSignals,
};
use serde::Serialize;

/// Cap on signal rows pulled into one scoring pass.
const MAX_SIGNAL_ROWS: usize = 20_000;
/// Sessions extracted per [`builder_profile_extract`] call. Small enough to stay
/// responsive, large enough that a few calls make visible progress.
const EXTRACT_BATCH: usize = 200;
/// Serialise the heavy paths: extraction parses transcripts, and two concurrent
/// passes would fight for the same connection and CPU.
static PROFILE_QUEUE: OnceLock<tokio::sync::Semaphore> = OnceLock::new();

async fn permit() -> Result<tokio::sync::SemaphorePermit<'static>, String> {
    PROFILE_QUEUE
        .get_or_init(|| tokio::sync::Semaphore::new(1))
        .acquire()
        .await
        .map_err(|_| "Profile queue closed".to_string())
}

/// A profile plus the slices that make it checkable: the same person scored per
/// tool, and over time.
#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuilderProfileOverview {
    pub profile: BuilderProfile,
    /// Same anchors, one row per tool — so these numbers are comparable, and a
    /// letter that only holds in one harness is visible as such.
    pub by_source: Vec<SourceProfile>,
    /// Rolling windows, most recent first — same direction as every other
    /// session list in the app.
    pub drift: Vec<DriftPoint>,
    /// Readable one-fact-per-card deck, families interleaved.
    pub highlights: Vec<Highlight>,
    pub coverage: Coverage,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceProfile {
    pub source: String,
    pub sessions: usize,
    pub code: String,
    pub confidence: f64,
    /// Axis key → score, for a compact comparison row.
    pub scores: Vec<(String, f64)>,
}

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftPoint {
    pub ended_at_ms: i64,
    pub sessions: usize,
    pub code: String,
    pub scores: Vec<(String, f64)>,
}

fn axis_scores(p: &BuilderProfile) -> Vec<(String, f64)> {
    p.axes
        .iter()
        .map(|a| (a.key.to_string(), a.score))
        .collect()
}

fn load(sources: Vec<String>, since_ms: Option<i64>) -> Result<Vec<SessionSignals>, String> {
    let conn = get_connection().map_err(|err| err.to_string())?;
    signal_store::load_signals(&conn, &sources, since_ms, MAX_SIGNAL_ROWS)
}

/// Score the cached signal rows. Cheap: no transcript parsing.
#[tauri::command]
pub async fn builder_profile_overview(
    sources: Option<Vec<String>>,
    since_ms: Option<i64>,
    include_drift: Option<bool>,
) -> Result<BuilderProfileOverview, String> {
    let _permit = permit().await?;
    tokio::task::spawn_blocking(move || {
        let sources = sources.unwrap_or_default();
        let with_drift = include_drift.unwrap_or(false);
        // Scoring is the expensive half: a load computes a dozen-plus full
        // profiles, each running an anchor-sensitivity search. Serve the whole
        // payload from cache unless the signal corpus itself moved.
        let scope_key = format!(
            "overview|{}|{:?}|{}",
            sources.join(","),
            since_ms,
            with_drift
        );
        let fingerprint = {
            let conn = get_connection().map_err(|err| err.to_string())?;
            signal_store::corpus_fingerprint(&conn)?
        };
        {
            let conn = get_connection().map_err(|err| err.to_string())?;
            if let Some(hit) = signal_store::cached_payload(&conn, &scope_key, &fingerprint)? {
                if let Ok(payload) = serde_json::from_str::<BuilderProfileOverview>(&hit) {
                    return Ok(payload);
                }
            }
        }
        let all = load(sources, since_ms)?;
        let conn = get_connection().map_err(|err| err.to_string())?;
        let coverage = signal_store::coverage(&conn)?;
        let profile = profile::profile_for(&all);
        let shares: Vec<f64> = profile::signals::parallel_shares(&all)
            .into_iter()
            .map(|(_, v)| v)
            .collect();
        let highlights = highlights::build(&all, &shares);

        let mut by_source: Vec<SourceProfile> = Vec::new();
        let mut names: Vec<String> = all.iter().map(|s| s.source.clone()).collect();
        names.sort();
        names.dedup();
        for name in names {
            let subset: Vec<SessionSignals> =
                all.iter().filter(|s| s.source == name).cloned().collect();
            if subset.len() < 5 {
                continue;
            }
            // Concurrency is recomputed within the subset on purpose: "how much
            // do you parallelise inside this tool" is the comparable question.
            let p = profile::profile_for(&subset);
            by_source.push(SourceProfile {
                source: name,
                sessions: subset.len(),
                code: p.code.clone(),
                confidence: p.confidence,
                scores: axis_scores(&p),
            });
        }
        by_source.sort_by(|a, b| b.sessions.cmp(&a.sessions));

        let mut drift = Vec::new();
        if with_drift {
            let mut ordered = all.clone();
            ordered.sort_by_key(|s| s.started_at_ms);
            const WINDOW: usize = 400;
            const STEP: usize = 200;
            if ordered.len() > WINDOW {
                let mut start = 0;
                while start + WINDOW <= ordered.len() {
                    let w = &ordered[start..start + WINDOW];
                    let p = profile::profile_for(w);
                    drift.push(DriftPoint {
                        ended_at_ms: w.last().map(|s| s.started_at_ms).unwrap_or(0),
                        sessions: w.len(),
                        code: p.code.clone(),
                        scores: axis_scores(&p),
                    });
                    start += STEP;
                }
                // Built oldest-first because the sweep walks time forwards;
                // presented newest-first.
                drift.reverse();
            }
        }

        let payload = BuilderProfileOverview {
            profile,
            by_source,
            drift,
            coverage,
            highlights,
        };
        if let (Ok(conn), Ok(json)) = (get_connection(), serde_json::to_string(&payload)) {
            // Best-effort: a cache write failure must not fail the read.
            let _ = signal_store::put_payload(&conn, &scope_key, &fingerprint, &json);
        }
        Ok(payload)
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractProgress {
    pub extracted_now: usize,
    pub coverage: Coverage,
    /// False once a call extracts nothing — the backlog is drained.
    pub more: bool,
}

/// Extract one bounded batch of not-yet-analysed sessions.
///
/// The panel calls this repeatedly while it is open. Newest sessions first, so
/// a partial profile describes recent behaviour rather than an arbitrary slice.
#[tauri::command]
pub async fn builder_profile_extract(limit: Option<usize>) -> Result<ExtractProgress, String> {
    let _permit = permit().await?;
    let batch = limit.unwrap_or(EXTRACT_BATCH).min(EXTRACT_BATCH);
    tokio::task::spawn_blocking(move || {
        let conn = get_connection().map_err(|err| err.to_string())?;
        let extracted_now = signal_store::backfill_session_signals(&conn, batch)?;
        Ok(ExtractProgress {
            extracted_now,
            coverage: signal_store::coverage(&conn)?,
            more: extracted_now > 0,
        })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}

/// The sessions at each end of one axis — the drill-down that lets someone
/// check a verdict against something they remember doing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AxisExemplars {
    pub axis: String,
    pub positive: Vec<ExemplarSession>,
    pub negative: Vec<ExemplarSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExemplarSession {
    pub session_id: String,
    pub source: String,
    pub started_at_ms: i64,
    pub score: f64,
}

#[tauri::command]
pub async fn builder_profile_exemplars(
    axis: String,
    sources: Option<Vec<String>>,
    since_ms: Option<i64>,
    limit: Option<usize>,
) -> Result<AxisExemplars, String> {
    let _permit = permit().await?;
    let take = limit.unwrap_or(5).clamp(1, 25);
    tokio::task::spawn_blocking(move || {
        let all = load(sources.unwrap_or_default(), since_ms)?;
        let def = profile::axes::AXES
            .iter()
            .chain(profile::axes::SECONDARY.iter())
            .find(|d| d.key == axis)
            .ok_or_else(|| format!("Unknown axis: {axis}"))?;

        // Score each session on its own so the extremes are per-session, not a
        // property of the aggregate.
        let inputs = profile::to_inputs(&all);
        let mut scored: Vec<(f64, &SessionSignals)> = inputs
            .iter()
            .filter_map(|i| profile::axes::session_score(i, def).map(|v| (v, i.signals)))
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        let pick = |rows: &[(f64, &SessionSignals)]| -> Vec<ExemplarSession> {
            rows.iter()
                .take(take)
                .map(|(score, s)| ExemplarSession {
                    session_id: s.session_id.clone(),
                    source: s.source.clone(),
                    started_at_ms: s.started_at_ms,
                    score: *score,
                })
                .collect()
        };
        let positive = pick(&scored);
        let mut tail: Vec<(f64, &SessionSignals)> = scored.into_iter().rev().collect();
        tail.truncate(take);
        Ok(AxisExemplars {
            axis,
            positive,
            negative: pick(&tail),
        })
    })
    .await
    .map_err(|err| format!("Task join error: {err}"))?
}
