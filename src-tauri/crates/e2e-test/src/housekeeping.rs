//! Housekeeping E2E scenarios (`--group housekeeping`).
//!
//! Exercises the deferred disk-cleanup pass
//! (`infrastructure::housekeeping::run_deferred_cleanup`) without waiting for
//! the 10-minute startup delay. Relies on three debug-only test endpoints:
//!
//! - `POST /agent/test/housekeeping/run`              — run the cleanup pass synchronously
//! - `POST /agent/test/housekeeping/seed-snapshots`   — plant N synthetic manifests + DB rows
//! - `POST /agent/test/housekeeping/seed-aged`        — plant an aged session dir
//! - `POST /agent/test/housekeeping/seed-session-dir` — plant a `cursor-config/<sid>/` or
//! - `POST /agent/test/housekeeping/seed-aged-file`   — plant a flat TTL file under `screenshots/` or `merkle/`
//! - `POST /agent/test/housekeeping/seed-plan-file`   — plant a file under `plans/<agent_subdir>/`
//! - `POST /agent/test/housekeeping/seed-worktree-dir` — plant `agent-worktrees/<repo_hash>/<sid>/`
//! - `POST /agent/test/housekeeping/seed-session-image` — plant `session-images/<name>`, optionally referenced in `agent_messages.images`
//! - `POST /agent/test/housekeeping/seed-gateway-binding` — plant a `gateway_bindings` row, optionally with a live `agent_sessions` row
//! - `POST /agent/test/housekeeping/seed-session-cache` — plant a `sessions` cache row with controlled `cached_at`
//! - `GET  /agent/test/housekeeping/snapshot-count`   — read `count_snapshots_for_session` result
//!
//! Each scenario seeds its own disjoint session IDs (`e2e-housekeeping-*`)
//! so runs can interleave with other tests without cross-contamination.

use super::config::Config;
use super::harness;

const MAX_SNAPSHOTS_PER_SESSION: usize = 100;

// ============================================
// HTTP helpers
// ============================================

async fn seed_snapshots(cfg: &Config, session_id: &str, count: usize) -> Result<(), String> {
    let url = format!("{}/agent/test/housekeeping/seed-snapshots", cfg.base_url);
    let body = serde_json::json!({
        "session_id": session_id,
        "count": count,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

async fn seed_aged(cfg: &Config, session_id: &str, age_days: u64) -> Result<(), String> {
    let url = format!("{}/agent/test/housekeeping/seed-aged", cfg.base_url);
    let body = serde_json::json!({
        "session_id": session_id,
        "age_days": age_days,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

async fn snapshot_count(cfg: &Config, session_id: &str) -> Result<i64, String> {
    let url = format!(
        "{}/agent/test/housekeeping/snapshot-count?session_id={}",
        cfg.base_url, session_id
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("count")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "Response missing 'count' field".to_string())
}

async fn run_housekeeping(cfg: &Config) -> Result<serde_json::Value, String> {
    let url = format!("{}/agent/test/housekeeping/run", cfg.base_url);
    let resp = reqwest::Client::new()
        .post(&url)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(json)
}

/// Seed a flat TTL file under a supported `~/.orgii/` root through the
/// debug-only housekeeping endpoint and return its absolute path.
async fn seed_aged_file(
    cfg: &Config,
    root: &str,
    name: &str,
    age_days: u64,
) -> Result<String, String> {
    let url = format!("{}/agent/test/housekeeping/seed-aged-file", cfg.base_url);
    let body = serde_json::json!({
        "root": root,
        "name": name,
        "age_days": age_days,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("path")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "response missing 'path'".to_string())
}

// ============================================
// Scenarios
// ============================================

/// Seed 105 synthetic manifests for a dedicated session, run the deferred
/// cleanup pass, and assert that exactly the 5 excess rows were capped while
/// the remaining 100 survive (positive + negative assertion).
pub async fn cap_sweep(cfg: &Config) -> bool {
    let session_id = format!("{}-housekeeping-cap", cfg.session_prefix);
    let overshoot = 5;
    let total = MAX_SNAPSHOTS_PER_SESSION + overshoot;

    if let Err(err) = seed_snapshots(cfg, &session_id, total).await {
        return harness::print_error("Housekeeping: Cap Sweep", &err);
    }

    let pre_count = snapshot_count(cfg, &session_id).await.unwrap_or(-1);

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Cap Sweep", &err),
    };

    let post_count = snapshot_count(cfg, &session_id).await.unwrap_or(-1);

    let manifests_capped = result
        .get("manifests_capped")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let sessions_capped = result
        .get("sessions_capped")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let blobs_capped = result
        .get("blobs_capped")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;

    harness::print_result(
        "Housekeeping: Cap Sweep",
        &result.to_string(),
        &[
            ("Seeded 105 rows", pre_count == total as i64),
            (
                "Post-cap count == 100",
                post_count == MAX_SNAPSHOTS_PER_SESSION as i64,
            ),
            ("Exactly 5 manifests capped", manifests_capped == overshoot),
            ("At least 1 session touched", sessions_capped >= 1),
            ("At least 5 blobs GC'd", blobs_capped >= overshoot),
            ("Did NOT over-prune (still have manifests)", post_count > 0),
        ],
    )
}

/// Seed an aged session directory (60 days old), seed a fresh session
/// directory alongside it, run the cleanup pass, and assert that only the
/// aged one was removed while the fresh one survives.
pub async fn ttl_prune(cfg: &Config) -> bool {
    let aged_sid = format!("{}-housekeeping-aged", cfg.session_prefix);
    let fresh_sid = format!("{}-housekeeping-fresh", cfg.session_prefix);

    if let Err(err) = seed_aged(cfg, &aged_sid, 60).await {
        return harness::print_error("Housekeeping: TTL Prune", &err);
    }
    // Fresh session: seed a single manifest with today's mtime (via regular
    // seed endpoint, which uses now() for the directory).
    if let Err(err) = seed_snapshots(cfg, &fresh_sid, 1).await {
        return harness::print_error("Housekeeping: TTL Prune", &err);
    }

    let aged_pre = snapshot_count(cfg, &aged_sid).await.unwrap_or(-1);
    let fresh_pre = snapshot_count(cfg, &fresh_sid).await.unwrap_or(-1);

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: TTL Prune", &err),
    };

    let aged_post = snapshot_count(cfg, &aged_sid).await.unwrap_or(-1);
    let fresh_post = snapshot_count(cfg, &fresh_sid).await.unwrap_or(-1);

    let sessions_removed = result
        .get("file_history_sessions_removed")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let db_rows_removed = result
        .get("file_history_db_rows_removed")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    harness::print_result(
        "Housekeeping: TTL Prune",
        &result.to_string(),
        &[
            ("Aged seeded", aged_pre >= 1),
            ("Fresh seeded", fresh_pre == 1),
            ("Aged session removed from DB", aged_post == 0),
            ("Fresh session survived", fresh_post == 1),
            ("Reported >= 1 session_removed", sessions_removed >= 1),
            ("Reported >= 1 db_row_removed", db_rows_removed >= 1),
        ],
    )
}

/// Run the cleanup pass against an empty/steady-state filesystem and assert
/// that no errors surface and all counters stay at zero. Acts as a smoke
/// test that the orchestrator + wiring is sound even when there's nothing
/// to prune.
pub async fn happy_noop(cfg: &Config) -> bool {
    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Happy Noop", &err),
    };

    let ok = result.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);

    harness::print_result(
        "Housekeeping: Happy Noop",
        &result.to_string(),
        &[
            ("Response ok", ok),
            (
                "Has manifests_capped field",
                result.get("manifests_capped").is_some(),
            ),
            (
                "Has log_files_removed field",
                result.get("log_files_removed").is_some(),
            ),
            (
                "Has file_history_sessions_removed field",
                result.get("file_history_sessions_removed").is_some(),
            ),
            (
                "Has cursor_configs_evicted field",
                result.get("cursor_configs_evicted").is_some(),
            ),
            (
                "Has gemini_homes_evicted field",
                result.get("gemini_homes_evicted").is_some(),
            ),
            (
                "Has screenshots_removed field",
                result.get("screenshots_removed").is_some(),
            ),
            (
                "Has plans_removed field",
                result.get("plans_removed").is_some(),
            ),
            (
                "Has merkle_snapshots_removed field",
                result.get("merkle_snapshots_removed").is_some(),
            ),
            (
                "Has agent_worktrees_evicted field",
                result.get("agent_worktrees_evicted").is_some(),
            ),
            (
                "Has session_images_evicted field",
                result.get("session_images_evicted").is_some(),
            ),
            (
                "Has gateway_bindings_evicted field",
                result.get("gateway_bindings_evicted").is_some(),
            ),
            (
                "Has session_cache_rows_evicted field",
                result.get("session_cache_rows_evicted").is_some(),
            ),
        ],
    )
}

// ============================================
// Helpers: cursor/gemini orphan sweeps
// ============================================

async fn seed_session_dir(
    cfg: &Config,
    root: &str,
    session_id: &str,
    insert_session_row: bool,
) -> Result<String, String> {
    let url = format!("{}/agent/test/housekeeping/seed-session-dir", cfg.base_url);
    let body = serde_json::json!({
        "root": root,
        "session_id": session_id,
        "insert_session_row": insert_session_row,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing 'path'".to_string())
}

/// Seed one orphan `cursor-config/<sid>/` (no matching `agent_sessions`
/// row) AND one live `cursor-config/<sid>/` (row inserted), run cleanup,
/// assert orphan gone, live survives. Positive+negative assertions for the
/// orphan sweep path.
pub async fn cursor_config_orphan_evict(cfg: &Config) -> bool {
    let orphan_sid = format!("{}-cursor-orphan", cfg.session_prefix);
    let live_sid = format!("{}-cursor-live", cfg.session_prefix);

    let orphan_path = match seed_session_dir(cfg, "cursor-config", &orphan_sid, false).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Cursor Config Orphan", &err),
    };
    let live_path = match seed_session_dir(cfg, "cursor-config", &live_sid, true).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Cursor Config Orphan", &err),
    };

    let orphan_pre = std::path::Path::new(&orphan_path).exists();
    let live_pre = std::path::Path::new(&live_path).exists();

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Cursor Config Orphan", &err),
    };

    let orphan_post = std::path::Path::new(&orphan_path).exists();
    let live_post = std::path::Path::new(&live_path).exists();

    let evicted = result
        .get("cursor_configs_evicted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Leave no trace: remove the live dir + DB row we planted so reruns
    // don't have a growing backlog of phony agent_sessions.
    let _ = std::fs::remove_dir_all(&live_path);

    harness::print_result(
        "Housekeeping: Cursor Config Orphan",
        &result.to_string(),
        &[
            ("Orphan cursor dir seeded", orphan_pre),
            ("Live cursor dir seeded", live_pre),
            ("Orphan cursor dir evicted", !orphan_post),
            ("Live cursor dir survived", live_post),
            ("Reported >= 1 cursor_configs_evicted", evicted >= 1),
        ],
    )
}

pub async fn screenshots_ttl(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let aged_name = format!("e2e-aged-{}.png", tag);
    let fresh_name = format!("e2e-fresh-{}.png", tag);

    let aged_path = match seed_aged_file(cfg, "screenshots", &aged_name, 8).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Screenshots TTL", &err),
    };
    let fresh_path = match seed_aged_file(cfg, "screenshots", &fresh_name, 0).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Screenshots TTL", &err),
    };

    let aged_pre = std::path::Path::new(&aged_path).exists();
    let fresh_pre = std::path::Path::new(&fresh_path).exists();

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Screenshots TTL", &err),
    };

    let aged_post = std::path::Path::new(&aged_path).exists();
    let fresh_post = std::path::Path::new(&fresh_path).exists();

    let removed = result
        .get("screenshots_removed")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Remove the surviving fresh file so the dir doesn't accumulate litter
    // across reruns.
    let _ = std::fs::remove_file(&fresh_path);

    harness::print_result(
        "Housekeeping: Screenshots TTL",
        &result.to_string(),
        &[
            ("Aged screenshot seeded", aged_pre),
            ("Fresh screenshot seeded", fresh_pre),
            ("Aged screenshot removed", !aged_post),
            ("Fresh screenshot survived", fresh_post),
            ("Reported >= 1 screenshots_removed", removed >= 1),
        ],
    )
}

/// Seed a file under `~/.orgii/plans/<agent_subdir>/<name>` via the
/// `housekeeping/seed-plan-file` debug endpoint. `age_days > 30` makes it
/// eligible for eviction under `PLANS_TTL_DAYS=30`.
async fn seed_plan_file(
    cfg: &Config,
    agent_subdir: &str,
    name: &str,
    age_days: u64,
) -> Result<String, String> {
    let url = format!("{}/agent/test/housekeeping/seed-plan-file", cfg.base_url);
    let body = serde_json::json!({
        "agent_subdir": agent_subdir,
        "name": name,
        "age_days": age_days,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing 'path'".to_string())
}

/// Seed one aged merkle snapshot (31 days > `MERKLE_TTL_DAYS=30`) AND one
/// fresh snapshot, run cleanup, and assert Rule 9 positive + negative.
pub async fn merkle_ttl(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let aged_name = format!("e2e-aged-{}.json", tag);
    let fresh_name = format!("e2e-fresh-{}.json", tag);

    let aged_path = match seed_aged_file(cfg, "merkle", &aged_name, 31).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Merkle TTL", &err),
    };
    let fresh_path = match seed_aged_file(cfg, "merkle", &fresh_name, 0).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Merkle TTL", &err),
    };

    let aged_pre = std::path::Path::new(&aged_path).exists();
    let fresh_pre = std::path::Path::new(&fresh_path).exists();

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Merkle TTL", &err),
    };

    let aged_post = std::path::Path::new(&aged_path).exists();
    let fresh_post = std::path::Path::new(&fresh_path).exists();

    let removed = result
        .get("merkle_snapshots_removed")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let _ = std::fs::remove_file(&fresh_path);

    harness::print_result(
        "Housekeeping: Merkle TTL",
        &result.to_string(),
        &[
            ("Aged merkle snapshot seeded", aged_pre),
            ("Fresh merkle snapshot seeded", fresh_pre),
            ("Aged merkle snapshot removed", !aged_post),
            ("Fresh merkle snapshot survived", fresh_post),
            ("Reported >= 1 merkle_snapshots_removed", removed >= 1),
        ],
    )
}

/// Seed a `sessions` cache row with controlled `cached_at` age (days).
/// `age_days > 30` makes it eligible for eviction under
/// `SESSION_CACHE_TTL_DAYS=30`.
async fn seed_session_cache(cfg: &Config, session_id: &str, age_days: u64) -> Result<(), String> {
    let url = format!(
        "{}/agent/test/housekeeping/seed-session-cache",
        cfg.base_url
    );
    let body = serde_json::json!({
        "session_id": session_id,
        "age_days": age_days,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

/// Ask the debug endpoint whether a `sessions` cache row exists for
/// `session_id`. Used by the session-cache TTL scenario.
async fn session_cache_exists(cfg: &Config, session_id: &str) -> Result<bool, String> {
    let url = format!(
        "{}/agent/test/housekeeping/session-cache-exists?session_id={}",
        cfg.base_url,
        urlencoding::encode(session_id)
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("exists")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "response missing 'exists'".to_string())
}

/// Seed a `gateway_bindings` row. When `insert_session_row=false`, the
/// target `agent_sessions` row is missing, so the sweep sees the binding
/// as orphan. When true, the binding is live (negative branch).
async fn seed_gateway_binding(
    cfg: &Config,
    session_key: &str,
    target_session_id: &str,
    insert_session_row: bool,
) -> Result<(), String> {
    let url = format!(
        "{}/agent/test/housekeeping/seed-gateway-binding",
        cfg.base_url
    );
    let body = serde_json::json!({
        "session_key": session_key,
        "target_session_id": target_session_id,
        "insert_session_row": insert_session_row,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Ok(())
}

/// Ask the debug endpoint whether a `gateway_bindings` row exists for
/// `session_key`. Used by the gateway-bindings orphan scenario.
async fn gateway_binding_exists(cfg: &Config, session_key: &str) -> Result<bool, String> {
    let url = format!(
        "{}/agent/test/housekeeping/gateway-binding-exists?session_key={}",
        cfg.base_url,
        urlencoding::encode(session_key)
    );
    let resp = reqwest::Client::new()
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("exists")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "response missing 'exists'".to_string())
}

/// Seed a `session-images/<name>` file. When `reference_in_message` is
/// true, an `agent_messages.images` row is also inserted pointing at this
/// file so the orphan sweep treats it as live (negative branch).
async fn seed_session_image(
    cfg: &Config,
    name: &str,
    reference_in_message: bool,
) -> Result<String, String> {
    let url = format!(
        "{}/agent/test/housekeeping/seed-session-image",
        cfg.base_url
    );
    let body = serde_json::json!({
        "name": name,
        "reference_in_message": reference_in_message,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing 'path'".to_string())
}

/// Seed an `agent-worktrees/<repo_hash>/<session_id>/` subdir via the
/// `housekeeping/seed-worktree-dir` debug endpoint. When
/// `insert_session_row` is true the seed also writes an `agent_sessions` row
/// so the orphan sweep treats it as live (negative branch).
async fn seed_worktree_dir(
    cfg: &Config,
    repo_hash: &str,
    session_id: &str,
    insert_session_row: bool,
) -> Result<String, String> {
    let url = format!("{}/agent/test/housekeeping/seed-worktree-dir", cfg.base_url);
    let body = serde_json::json!({
        "repo_hash": repo_hash,
        "session_id": session_id,
        "insert_session_row": insert_session_row,
    });
    let resp = reqwest::Client::new()
        .post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|err| format!("HTTP error: {}", err))?;
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|err| format!("JSON parse error: {}", err))?;
    if let Some(err) = json.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    json.get("path")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "response missing 'path'".to_string())
}

/// Seed an aged plan file (31d > `PLANS_TTL_DAYS=30`) inside its own
/// agent_subdir AND a fresh plan file in a separate subdir, run cleanup,
/// and assert Rule 9 positive + negative. Each subdir is unique per run so
/// the empty-dir cleanup of `prune_old_files_recursive` is also exercised
/// (the aged subdir should be gone after cleanup).
pub async fn plans_ttl(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let aged_subdir = format!("e2e-aged-{}", tag);
    let fresh_subdir = format!("e2e-fresh-{}", tag);
    let aged_name = "plan.md";
    let fresh_name = "plan.md";

    let aged_path = match seed_plan_file(cfg, &aged_subdir, aged_name, 31).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Plans TTL", &err),
    };
    let fresh_path = match seed_plan_file(cfg, &fresh_subdir, fresh_name, 0).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Plans TTL", &err),
    };

    let aged_pre = std::path::Path::new(&aged_path).exists();
    let fresh_pre = std::path::Path::new(&fresh_path).exists();
    let aged_dir_pre = std::path::Path::new(&aged_path)
        .parent()
        .map(|p| p.exists())
        .unwrap_or(false);

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Plans TTL", &err),
    };

    let aged_post = std::path::Path::new(&aged_path).exists();
    let fresh_post = std::path::Path::new(&fresh_path).exists();
    // Aged subdir should be empty → swept by `prune_old_files_recursive`.
    let aged_dir_post = std::path::Path::new(&aged_path)
        .parent()
        .map(|p| p.exists())
        .unwrap_or(false);

    let removed = result
        .get("plans_removed")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let _ = std::fs::remove_file(&fresh_path);
    if let Some(parent) = std::path::Path::new(&fresh_path).parent() {
        let _ = std::fs::remove_dir(parent);
    }

    harness::print_result(
        "Housekeeping: Plans TTL",
        &result.to_string(),
        &[
            ("Aged plan file seeded", aged_pre),
            ("Fresh plan file seeded", fresh_pre),
            ("Aged plan subdir created", aged_dir_pre),
            ("Aged plan file removed", !aged_post),
            ("Fresh plan file survived", fresh_post),
            ("Aged plan subdir cleaned (empty-dir sweep)", !aged_dir_post),
            ("Reported >= 1 plans_removed", removed >= 1),
        ],
    )
}

/// Seed one orphan worktree (no matching `agent_sessions` row) AND one
/// live worktree (with the DB row), run cleanup, and assert Rule 9:
/// orphan is gone, live survives, counter reports >= 1.
pub async fn agent_worktrees_orphan_evict(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let repo_hash = format!("e2e-repo-{}", tag);
    let orphan_sid = format!("e2e-orphan-{}", tag);
    let live_sid = format!("e2e-live-{}", tag);

    let orphan_path = match seed_worktree_dir(cfg, &repo_hash, &orphan_sid, false).await {
        Ok(p) => p,
        Err(err) => {
            return harness::print_error("Housekeeping: Agent worktrees orphan evict", &err)
        }
    };
    let live_path = match seed_worktree_dir(cfg, &repo_hash, &live_sid, true).await {
        Ok(p) => p,
        Err(err) => {
            return harness::print_error("Housekeeping: Agent worktrees orphan evict", &err)
        }
    };

    let orphan_pre = std::path::Path::new(&orphan_path).exists();
    let live_pre = std::path::Path::new(&live_path).exists();

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => {
            return harness::print_error("Housekeeping: Agent worktrees orphan evict", &err)
        }
    };

    let orphan_post = std::path::Path::new(&orphan_path).exists();
    let live_post = std::path::Path::new(&live_path).exists();

    let evicted = result
        .get("agent_worktrees_evicted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Clean up the surviving live worktree + its synthetic session row so
    // reruns stay idempotent. The repo_hash dir is removed once both sid
    // subdirs are gone.
    let _ = std::fs::remove_dir_all(&live_path);
    if let Some(repo_dir) = std::path::Path::new(&live_path).parent() {
        let _ = std::fs::remove_dir(repo_dir);
    }

    harness::print_result(
        "Housekeeping: Agent worktrees orphan evict",
        &result.to_string(),
        &[
            ("Orphan worktree seeded", orphan_pre),
            ("Live worktree seeded", live_pre),
            ("Orphan worktree evicted", !orphan_post),
            ("Live worktree survived", live_post),
            ("Reported >= 1 agent_worktrees_evicted", evicted >= 1),
        ],
    )
}

/// Seed one orphan session-image (not referenced by any `agent_messages`
/// row) AND one referenced image, run cleanup, and assert Rule 9 positive
/// + negative.
pub async fn session_images_orphan_evict(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let orphan_name = format!("e2e-orphan-{}.png", tag);
    let live_name = format!("e2e-live-{}.png", tag);

    let orphan_path = match seed_session_image(cfg, &orphan_name, false).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Session images orphan evict", &err),
    };
    let live_path = match seed_session_image(cfg, &live_name, true).await {
        Ok(p) => p,
        Err(err) => return harness::print_error("Housekeeping: Session images orphan evict", &err),
    };

    let orphan_pre = std::path::Path::new(&orphan_path).exists();
    let live_pre = std::path::Path::new(&live_path).exists();

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Session images orphan evict", &err),
    };

    let orphan_post = std::path::Path::new(&orphan_path).exists();
    let live_post = std::path::Path::new(&live_path).exists();

    let evicted = result
        .get("session_images_evicted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Clean up the surviving live image file; the seed row in
    // `agent_messages` is left in place (it's cheap and doesn't affect
    // other scenarios — every run generates fresh uuids).
    let _ = std::fs::remove_file(&live_path);

    harness::print_result(
        "Housekeeping: Session images orphan evict",
        &result.to_string(),
        &[
            ("Orphan image seeded", orphan_pre),
            ("Live image seeded", live_pre),
            ("Orphan image evicted", !orphan_post),
            ("Live image survived", live_post),
            ("Reported >= 1 session_images_evicted", evicted >= 1),
        ],
    )
}

/// Seed one orphan `gateway_bindings` row (pointing at a non-existent
/// `agent_sessions` row) AND one live binding (target exists), run
/// cleanup, and assert Rule 9: orphan is gone, live survives, counter
/// reports >= 1.
pub async fn gateway_bindings_orphan_evict(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let orphan_key = format!("e2e-orphan-key-{}", tag);
    let live_key = format!("e2e-live-key-{}", tag);
    let orphan_target = format!("e2e-orphan-target-{}", tag);
    let live_target = format!("e2e-live-target-{}", tag);

    if let Err(err) = seed_gateway_binding(cfg, &orphan_key, &orphan_target, false).await {
        return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err);
    }
    if let Err(err) = seed_gateway_binding(cfg, &live_key, &live_target, true).await {
        return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err);
    }

    let orphan_pre = match gateway_binding_exists(cfg, &orphan_key).await {
        Ok(b) => b,
        Err(err) => {
            return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err)
        }
    };
    let live_pre = match gateway_binding_exists(cfg, &live_key).await {
        Ok(b) => b,
        Err(err) => {
            return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err)
        }
    };

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => {
            return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err)
        }
    };

    let orphan_post = match gateway_binding_exists(cfg, &orphan_key).await {
        Ok(b) => b,
        Err(err) => {
            return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err)
        }
    };
    let live_post = match gateway_binding_exists(cfg, &live_key).await {
        Ok(b) => b,
        Err(err) => {
            return harness::print_error("Housekeeping: Gateway bindings orphan evict", &err)
        }
    };

    let evicted = result
        .get("gateway_bindings_evicted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    harness::print_result(
        "Housekeeping: Gateway bindings orphan evict",
        &result.to_string(),
        &[
            ("Orphan binding seeded", orphan_pre),
            ("Live binding seeded", live_pre),
            ("Orphan binding evicted", !orphan_post),
            ("Live binding survived", live_post),
            ("Reported >= 1 gateway_bindings_evicted", evicted >= 1),
        ],
    )
}

/// Seed one aged `sessions` cache row (31d > `SESSION_CACHE_TTL_DAYS=30`)
/// AND one fresh row, run cleanup, and assert Rule 9: aged is evicted,
/// fresh survives, counter reports >= 1.
pub async fn session_cache_ttl(cfg: &Config) -> bool {
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let aged_sid = format!("e2e-aged-sess-{}", tag);
    let fresh_sid = format!("e2e-fresh-sess-{}", tag);

    if let Err(err) = seed_session_cache(cfg, &aged_sid, 31).await {
        return harness::print_error("Housekeeping: Session cache TTL", &err);
    }
    if let Err(err) = seed_session_cache(cfg, &fresh_sid, 0).await {
        return harness::print_error("Housekeeping: Session cache TTL", &err);
    }

    let aged_pre = match session_cache_exists(cfg, &aged_sid).await {
        Ok(b) => b,
        Err(err) => return harness::print_error("Housekeeping: Session cache TTL", &err),
    };
    let fresh_pre = match session_cache_exists(cfg, &fresh_sid).await {
        Ok(b) => b,
        Err(err) => return harness::print_error("Housekeeping: Session cache TTL", &err),
    };

    let result = match run_housekeeping(cfg).await {
        Ok(json) => json,
        Err(err) => return harness::print_error("Housekeeping: Session cache TTL", &err),
    };

    let aged_post = match session_cache_exists(cfg, &aged_sid).await {
        Ok(b) => b,
        Err(err) => return harness::print_error("Housekeeping: Session cache TTL", &err),
    };
    let fresh_post = match session_cache_exists(cfg, &fresh_sid).await {
        Ok(b) => b,
        Err(err) => return harness::print_error("Housekeeping: Session cache TTL", &err),
    };

    let evicted = result
        .get("session_cache_rows_evicted")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    harness::print_result(
        "Housekeeping: Session cache TTL",
        &result.to_string(),
        &[
            ("Aged session-cache row seeded", aged_pre),
            ("Fresh session-cache row seeded", fresh_pre),
            ("Aged session-cache row evicted", !aged_post),
            ("Fresh session-cache row survived", fresh_post),
            ("Reported >= 1 session_cache_rows_evicted", evicted >= 1),
        ],
    )
}
