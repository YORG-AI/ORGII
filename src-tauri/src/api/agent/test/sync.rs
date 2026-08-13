//! `/agent/test/sync/*` endpoints (debug-only).
//!
//! Drive the pluggable sync framework end-to-end from the e2e binary
//! without spinning up a real adapter network. Every handler operates
//! on a caller-supplied `slug` so scenarios can use throwaway project
//! identifiers and run in any order without cross-talk.
//!
//! Endpoint surface (each one has at least one e2e scenario call site):
//!
//! - `POST /agent/test/sync/seed-project` — create an empty `projects`
//!   row and attach the `echo` adapter.
//! - `POST /agent/test/sync/enqueue` — append one outbox row.
//! - `POST /agent/test/sync/pump` — run one synchronous push pump
//!   for the given project, ignoring backoff timers.
//! - `POST /agent/test/sync/echo-flag` — toggle the Echo adapter's
//!   `force_next_failure` / `force_persistent_failure` debug flags.
//! - `GET  /agent/test/sync/status` — the same `SyncStatusReport`
//!   the `project_sync_status` Tauri command returns.
//! - `GET  /agent/test/sync/problems` — the `Vec<OutboxProblemRow>`
//!   list `project_sync_list_problems` returns.
//! - `GET  /agent/test/sync/inspect-entry` — single-row `OutboxEntry`
//!   lookup by `entry_id`. Lets scenarios observe rows in any state
//!   (including `Pending`/`Succeeded`), which the problems endpoint
//!   deliberately hides.
//! - `POST /agent/test/sync/requeue` — `io::requeue_one`.
//! - `POST /agent/test/sync/discard` — `io::discard_one` (hard delete).
//! - `POST /agent/test/sync/force-push` — same code path as
//!   `project_sync_force_push` (`io::requeue_for_project`).
//! - `POST /agent/test/sync/cleanup` — drop the project's outbox
//!   rows + `projects` row so a re-run starts clean.
//!
//! All handlers are gated by the parent `mod test` `#[cfg(debug_assertions)]`,
//! so no inner gating is required here.

#![cfg(debug_assertions)]

use axum::Json;
use serde::Deserialize;
use serde_json::json;

use project_management::projects::commands::sync as sync_commands;
use project_management::projects::io::{
    apply_remote_merge, read_work_item, write_work_item, FieldRevision, REVISION_SOURCE_LOCAL,
};
use project_management::projects::types::WorkItemFrontmatter;
use project_management::sync::types::{EntityType, OutboxEntry, OutboxOp, OutboxStatus};
use project_management::sync::{
    self, adapter::ExternalChange, adapters, conflict_log, import as sync_import, webhook_secrets,
};

// ============================================================================
// Request bodies
// ============================================================================

#[derive(Debug, Deserialize)]
pub struct SeedProjectRequest {
    slug: String,
    #[serde(default)]
    adapter_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EnqueueRequest {
    slug: String,
    entity_type: String,
    op: String,
    entity_id: String,
    #[serde(default)]
    payload: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct PumpRequest {
    slug: String,
}

#[derive(Debug, Deserialize)]
pub struct EchoFlagRequest {
    slug: String,
    #[serde(default)]
    force_next_failure: Option<bool>,
    #[serde(default)]
    force_persistent_failure: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct EntryIdRequest {
    slug: String,
    entry_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct SlugOnlyRequest {
    slug: String,
}

#[derive(Debug, Deserialize)]
pub struct SlugQuery {
    slug: String,
}

#[derive(Debug, Deserialize)]
pub struct InspectEntryQuery {
    entry_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct SlugAdapterRequest {
    slug: String,
    adapter_id: String,
}

#[derive(Debug, Deserialize)]
pub struct SlugAdapterQuery {
    slug: String,
    adapter_id: String,
}

#[derive(Debug, Deserialize)]
pub struct ImportPumpRequest {
    slug: String,
    adapter_id: String,
    /// Optional cap on pages drained this call. Defaults to 1, matching
    /// `MAX_IMPORT_PAGES_PER_TICK` in the worker so scenarios can pin
    /// the per-tick walk and assert one cycle == one page.
    #[serde(default)]
    max_pages: Option<u32>,
}

/// Request body for `/test/sync/conflict/seed-work-item`.
///
/// Stamps a synthetic work item plus per-field revisions and an
/// `external_ref` so the merge resolver can identity-match a follow-up
/// `inject-merge-external` call. Title/status are the only fields the
/// Echo adapter mirrors (`ECHO_FIELD_MAP`); both are required so a
/// conflict scenario can flip either or both on the remote side.
#[derive(Debug, Deserialize)]
pub struct ConflictSeedWorkItemRequest {
    slug: String,
    adapter_id: String,
    short_id: String,
    /// External id stamped under `external_refs[adapter_id]`. The merge
    /// path calls `find_by_external_ref(slug, adapter_id, external_id)`
    /// to locate the local row, so this string must match what the
    /// follow-up `inject-merge-external` uses.
    external_id: String,
    title: String,
    status: String,
    /// Wall-clock millis the seeded `FieldRevision`s use as their
    /// `mtime`. Scenarios pass a value strictly greater than the
    /// remote `remote_updated_at` they'll inject, which is the
    /// invariant the resolver checks to keep local.
    local_mtime_ms: i64,
}

/// Request body for `/test/sync/conflict/inject-merge-external`.
///
/// Appends one `merge_external` outbox row carrying an `ExternalChange`
/// payload that targets the work item seeded by the previous endpoint.
/// `remote_updated_at_ms` < `local_mtime_ms` from the seed step is
/// what trips the field-level resolver into "keep local", which is
/// the precondition `conflict_log::detect_conflicts` needs.
#[derive(Debug, Deserialize)]
pub struct ConflictInjectMergeRequest {
    slug: String,
    external_id: String,
    /// Map of remote field name → new value. Echo only mirrors
    /// `title` and `status`; other keys are accepted but the resolver
    /// will ignore them through `entity_field_map`.
    remote_fields: serde_json::Value,
    /// `ExternalChange::remote_updated_at` in unix-epoch ms. Pass a
    /// value strictly less than the seed's `local_mtime_ms` to drive
    /// a "keep local" verdict — that's the only verdict that produces
    /// a conflict row in the audit log.
    remote_updated_at_ms: i64,
}

#[derive(Debug, Deserialize)]
pub struct ConflictIdRequest {
    conflict_id: i64,
}

// ============================================================================
// Helpers
// ============================================================================

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn err_json(message: impl Into<String>) -> Json<serde_json::Value> {
    Json(json!({ "error": message.into() }))
}

// ============================================================================
// Handlers
// ============================================================================

/// Insert (or upsert) a `projects` row for `slug` and attach the
/// requested adapter (defaults to `echo`).
///
/// The row carries the minimum fields the `projects` schema requires
/// (`id`, `name`, `slug`, `short_id_prefix`, `created_at`,
/// `updated_at`). We use a deterministic synthetic `id` so a
/// re-seed of the same slug overwrites cleanly via the
/// `ON CONFLICT(id)` upsert clause; any prior outbox rows for the
/// slug survive because we never touch `outbox_entries` here.
pub async fn test_sync_seed_project(
    Json(request): Json<SeedProjectRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.unwrap_or_else(|| "echo".to_string());

    if adapters::get(&adapter_id).is_none() {
        return err_json(format!("unknown adapter '{}'", adapter_id));
    }

    let task_slug = slug.clone();
    let task_adapter = adapter_id.clone();
    let connection_id = format!("connection-{slug}");
    let task_connection_id = connection_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = sync::io::conn()?;
        let now = now_ms();
        let synthetic_id = format!("e2e-sync-{}", task_slug);
        let prefix = "E2E";
        conn.execute(
            "INSERT INTO projects
                (id, name, slug, short_id_prefix, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                slug = excluded.slug,
                short_id_prefix = excluded.short_id_prefix,
                updated_at = excluded.updated_at",
            rusqlite::params![synthetic_id, task_slug, task_slug, prefix, now, now],
        )
        .map_err(|err| format!("DB error (seed project): {}", err))?;
        sync::io::attach_adapter(&conn, &task_slug, &task_adapter, "{}", &task_connection_id)?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(json!({
            "ok": true,
            "slug": slug,
            "adapter_id": adapter_id,
            "sync_connection_id": connection_id
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Append one outbox row for `slug`. Returns the new row's `id`.
pub async fn test_sync_enqueue(Json(request): Json<EnqueueRequest>) -> Json<serde_json::Value> {
    let entity_type = match EntityType::from_db_str(&request.entity_type) {
        Ok(value) => value,
        Err(err) => return err_json(err),
    };
    let op = match OutboxOp::from_db_str(&request.op) {
        Ok(value) => value,
        Err(err) => return err_json(err),
    };
    let payload_json = request
        .payload
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| format!("payload serialization failed: {}", err));
    let payload_json = match payload_json {
        Ok(opt) => opt.unwrap_or_else(|| "{}".to_string()),
        Err(err) => return err_json(err),
    };

    let slug = request.slug.clone();
    let entity_id = request.entity_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<i64, String> {
        let conn = sync::io::conn()?;
        let entry = OutboxEntry {
            id: None,
            project_slug: slug,
            entity_type,
            entity_id,
            op,
            field_path: None,
            payload_json,
            created_at: now_ms(),
            retry_count: 0,
            last_attempted_at: None,
            last_error: None,
            status: OutboxStatus::Pending,
        };
        sync::io::append(&conn, &entry)
    })
    .await;

    match result {
        Ok(Ok(id)) => Json(json!({ "ok": true, "id": id })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Pump the worker once for `slug`. See
/// [`project_management::sync::worker::pump_once_for_project`]
/// for the exact semantics — backoff timers are reset for the slug's
/// pending rows so the cycle drains them immediately.
pub async fn test_sync_pump(Json(request): Json<PumpRequest>) -> Json<serde_json::Value> {
    match sync::worker::pump_once_for_project(&request.slug).await {
        Ok(processed) => Json(json!({ "ok": true, "processed": processed })),
        Err(err) => err_json(err),
    }
}

/// Toggle the Echo adapter's per-slug debug flags. Either field may
/// be omitted to leave that flag untouched. Returns the request as
/// echo so the e2e harness can sanity-check it landed.
pub async fn test_sync_echo_flag(Json(request): Json<EchoFlagRequest>) -> Json<serde_json::Value> {
    if let Some(force) = request.force_next_failure {
        adapters::EchoAdapter::set_force_next_failure(&request.slug, force);
    }
    if let Some(force) = request.force_persistent_failure {
        adapters::EchoAdapter::set_force_persistent_failure(&request.slug, force);
    }
    Json(json!({
        "ok": true,
        "slug": request.slug,
        "force_next_failure": request.force_next_failure,
        "force_persistent_failure": request.force_persistent_failure,
    }))
}

/// Snapshot of `slug`'s sync state — mirrors what the
/// `project_sync_status` Tauri command returns.
pub async fn test_sync_status(
    axum::extract::Query(query): axum::extract::Query<SlugQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = sync::io::conn()?;
        let binding = sync::io::read_adapter_binding(&conn, &slug)?;
        let adapter_id = binding.as_ref().map(|binding| binding.adapter_id.clone());
        let sync_connection_id = binding.map(|binding| binding.connection_id);
        let pending_count = sync::io::count_by_status(&conn, &slug, OutboxStatus::Pending)?;
        let failed_count = sync::io::count_by_status(&conn, &slug, OutboxStatus::Failed)?;
        let abandoned_count = sync::io::count_by_status(&conn, &slug, OutboxStatus::Abandoned)?;
        let succeeded_count = sync::io::count_by_status(&conn, &slug, OutboxStatus::Succeeded)?;
        let in_flight_count = sync::io::count_by_status(&conn, &slug, OutboxStatus::InFlight)?;
        let last_error = sync::io::last_error_for_project(&conn, &slug)?;
        // A `.ok()` here silently turned a DB error into "no
        // last_pull_at", which the E2E sync runner could mistake
        // for "we've never synced this project" and skip its
        // freshness assertions. Warn so a transient sqlite issue
        // is visible while still degrading gracefully.
        let last_pull_at = match sync::io::read_sync_cursor(&conn, &slug) {
            Ok(cursor) => cursor.last_pull_at,
            Err(err) => {
                tracing::warn!(
                    slug = %slug,
                    error = %err,
                    "test::sync: read_sync_cursor DB error; reporting last_pull_at=null"
                );
                None
            }
        };
        Ok(json!({
            "adapter_id": adapter_id,
            "sync_connection_id": sync_connection_id,
            "last_pull_at": last_pull_at,
            "pending_count": pending_count,
            "failed_count": failed_count,
            "abandoned_count": abandoned_count,
            "succeeded_count": succeeded_count,
            "in_flight_count": in_flight_count,
            "last_error": last_error,
        }))
    })
    .await;

    match result {
        Ok(Ok(value)) => Json(json!({ "ok": true, "report": value })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// `Vec<OutboxProblemRow>` — same wire shape as the
/// `project_sync_list_problems` Tauri command, returned untouched so
/// the e2e harness can grep field names directly.
pub async fn test_sync_problems(
    axum::extract::Query(query): axum::extract::Query<SlugQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = sync::io::conn()?;
        let rows = sync::io::list_problems(&conn, &slug)?;
        let value = serde_json::to_value(&rows)
            .map_err(|err| format!("serialize OutboxProblemRow list: {}", err))?;
        Ok(value)
    })
    .await;

    match result {
        Ok(Ok(rows)) => Json(json!({ "ok": true, "rows": rows })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Single-row `OutboxEntry` lookup by `entry_id`. Used by scenarios
/// that need to observe a row in any state — including `Pending`
/// and `Succeeded` — which the problems-list endpoint deliberately
/// hides (it scopes to `Failed | Abandoned`).
///
/// Wire shape: `{ ok: true, entry: <OutboxEntry serde JSON> }`. The
/// entry serializes through the same `Serialize` impl as the
/// production wire code, so e2e assertions can dot-access fields by
/// the canonical names.
pub async fn test_sync_inspect_entry(
    axum::extract::Query(query): axum::extract::Query<InspectEntryQuery>,
) -> Json<serde_json::Value> {
    let entry_id = query.entry_id;
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = sync::io::conn()?;
        let entry = sync::io::load_by_id(&conn, entry_id)?;
        serde_json::to_value(&entry).map_err(|err| format!("serialize OutboxEntry: {}", err))
    })
    .await;

    match result {
        Ok(Ok(entry)) => Json(json!({ "ok": true, "entry": entry })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Requeue exactly one row by id. `slug` is required so the caller
/// can keep its scenario assertions colocated with the rest of the
/// test even though the underlying `requeue_one` call doesn't strictly
/// need it.
pub async fn test_sync_requeue(Json(request): Json<EntryIdRequest>) -> Json<serde_json::Value> {
    let entry_id = request.entry_id;
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let conn = sync::io::conn()?;
        sync::io::requeue_one(&conn, entry_id)
    })
    .await;

    match result {
        Ok(Ok(touched_slug)) => {
            if touched_slug != request.slug {
                return err_json(format!(
                    "slug mismatch: requested='{}' touched='{}'",
                    request.slug, touched_slug
                ));
            }
            Json(json!({ "ok": true, "slug": touched_slug, "entry_id": entry_id }))
        }
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Hard-delete one outbox row by id. See the docstring on
/// [`sync::io::discard_one`] for the design rationale (DELETE rather
/// than `status='abandoned'`); scenario `sync-discard-blocks-force-push-resurrection`
/// is the regression pin for that decision.
pub async fn test_sync_discard(Json(request): Json<EntryIdRequest>) -> Json<serde_json::Value> {
    let entry_id = request.entry_id;
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let conn = sync::io::conn()?;
        sync::io::discard_one(&conn, entry_id)
    })
    .await;

    match result {
        Ok(Ok(touched_slug)) => {
            if touched_slug != request.slug {
                return err_json(format!(
                    "slug mismatch: requested='{}' touched='{}'",
                    request.slug, touched_slug
                ));
            }
            Json(json!({ "ok": true, "slug": touched_slug, "entry_id": entry_id }))
        }
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Same code path as `project_sync_force_push` — re-queues every
/// `Failed` and `Abandoned` row for `slug` back to `Pending`.
/// Returns the count of touched rows.
pub async fn test_sync_force_push(Json(request): Json<SlugOnlyRequest>) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let conn = sync::io::conn()?;
        sync::io::requeue_for_project(&conn, &slug)
    })
    .await;

    match result {
        Ok(Ok(count)) => Json(json!({ "ok": true, "requeued": count })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Mint a webhook secret for `(slug, adapter_id)` and return the
/// plaintext value so the e2e harness can compute valid HMAC-SHA256
/// signatures. Mirrors `webhook_secrets::rotate_secret`. Used by the
/// `Sync: Webhook *` scenarios in `crates/e2e-test/src/sync_webhook.rs`.
///
/// The plaintext secret never leaves this debug surface in production
/// builds — the entire `mod test` is `#[cfg(debug_assertions)]`.
pub async fn test_sync_webhook_install(
    Json(request): Json<SlugAdapterRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    if adapters::get(&adapter_id).is_none() {
        return err_json(format!("unknown adapter '{}'", adapter_id));
    }
    let result = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let conn = sync::io::conn()?;
        webhook_secrets::rotate_secret(&conn, &slug, &adapter_id, now_ms())
    })
    .await;
    match result {
        Ok(Ok(secret_hex)) => Json(json!({
            "ok": true,
            "slug": request.slug,
            "adapter_id": request.adapter_id,
            "secret_hex": secret_hex,
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Read `projects.sync_last_webhook_at` for `slug` so the e2e harness
/// can assert whether a delivery landed and when. Returns
/// `{"last_webhook_at": null}` when no delivery has been recorded
/// (or the project doesn't exist yet — caller seeds first).
pub async fn test_sync_webhook_status(
    axum::extract::Query(query): axum::extract::Query<SlugQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let task_slug = slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<Option<i64>, String> {
        let conn = sync::io::conn()?;
        sync::io::read_last_webhook_at(&conn, &task_slug)
    })
    .await;
    match result {
        Ok(Ok(stamp)) => Json(json!({
            "ok": true,
            "slug": slug,
            "last_webhook_at": stamp,
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Reset `projects.sync_last_webhook_at` to NULL so the
/// `webhook_fall_back_to_poll_when_stale` scenario can simulate
/// "no delivery in WEBHOOK_FRESHNESS_WINDOW_MS" without waiting on
/// `Instant`-driven worker timers. Idempotent: a missing project row
/// is treated as success because the post-condition (NULL stamp) is
/// already satisfied.
pub async fn test_sync_webhook_clear_stamp(
    Json(request): Json<SlugOnlyRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let conn = sync::io::conn()?;
        conn.execute(
            "UPDATE projects SET sync_last_webhook_at = NULL WHERE slug = ?1",
            rusqlite::params![slug],
        )
        .map_err(|err| format!("DB error (clear webhook stamp): {}", err))
    })
    .await;
    match result {
        Ok(Ok(rows)) => Json(json!({
            "ok": true,
            "slug": request.slug,
            "rows_affected": rows,
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Idempotently delete the project + every outbox row owned by it.
/// Also clears the Echo adapter's debug flags for the slug so a
/// re-run starts from a clean state.
pub async fn test_sync_cleanup(Json(request): Json<SlugOnlyRequest>) -> Json<serde_json::Value> {
    let slug = request.slug.clone();

    adapters::EchoAdapter::set_force_next_failure(&slug, false);
    adapters::EchoAdapter::set_force_persistent_failure(&slug, false);

    let result = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        let conn = sync::io::conn()?;
        let outbox_deleted = conn
            .execute(
                "DELETE FROM outbox_entries WHERE project_slug = ?1",
                rusqlite::params![slug],
            )
            .map_err(|err| format!("DB error (cleanup outbox): {}", err))?;
        // Drop any import_progress rows so a re-seed of the same slug
        // doesn't pick up stale state (a leftover `cancelled` row
        // would shadow `ensure_pending` on the new attach).
        conn.execute(
            "DELETE FROM import_progress WHERE project_slug = ?1",
            rusqlite::params![slug],
        )
        .map_err(|err| format!("DB error (cleanup import_progress): {}", err))?;
        // `outbox_conflicts` does NOT have an ON DELETE CASCADE link
        // to `projects`, so we have to clear it explicitly. A
        // leftover row would survive the project-level cleanup and
        // pollute the next run's `conflict_log::list_for_project`.
        conn.execute(
            "DELETE FROM outbox_conflicts WHERE project_slug = ?1",
            rusqlite::params![slug],
        )
        .map_err(|err| format!("DB error (cleanup outbox_conflicts): {}", err))?;
        // `webhook_secrets` is keyed by `(project_slug, adapter_id)`
        // and is NOT cascade-linked to `projects`. A leftover row
        // would let a future delivery to the recycled slug verify
        // against a stale secret — surface that as a clean reset.
        conn.execute(
            "DELETE FROM webhook_secrets WHERE project_slug = ?1",
            rusqlite::params![slug],
        )
        .map_err(|err| format!("DB error (cleanup webhook_secrets): {}", err))?;
        conn.execute(
            "DELETE FROM projects WHERE slug = ?1",
            rusqlite::params![slug],
        )
        .map_err(|err| format!("DB error (cleanup project): {}", err))?;
        Ok(outbox_deleted as u64)
    })
    .await;

    match result {
        Ok(Ok(count)) => Json(json!({ "ok": true, "outbox_rows_deleted": count })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

// ============================================================================
// import_progress debug surface
// ============================================================================

/// Idempotently insert a `pending` import_progress row for
/// `(slug, adapter_id)`. Mirrors the path the production
/// `project_sync_attach_adapter` Tauri command takes after a
/// successful attach.
pub async fn test_sync_import_ensure_pending(
    Json(request): Json<SlugAdapterRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let conn = sync::io::conn()?;
        sync_import::ensure_pending(&conn, &slug, &adapter_id, now_ms())
    })
    .await;
    match result {
        Ok(Ok(created)) => Json(json!({
            "ok": true,
            "created": created,
            "slug": request.slug,
            "adapter_id": request.adapter_id,
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Read the current `ImportProgressRow` for `(slug, adapter_id)`.
/// Mirrors `project_sync_import_status`. `null` when no row exists.
pub async fn test_sync_import_status(
    axum::extract::Query(query): axum::extract::Query<SlugAdapterQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let adapter_id = query.adapter_id.clone();
    let result = tokio::task::spawn_blocking(
        move || -> Result<Option<sync_import::ImportProgressRow>, String> {
            let conn = sync::io::conn()?;
            sync_import::read_status(&conn, &slug, &adapter_id)
        },
    )
    .await;
    match result {
        Ok(Ok(row)) => Json(json!({ "ok": true, "row": row })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Drive one (or `max_pages`) iterations of the worker import cycle.
/// Lets scenarios pump the import pipeline synchronously without
/// waiting for the worker's 60s tick. Returns the number of pages
/// the cycle drained — useful as an assertion target.
pub async fn test_sync_import_pump(
    Json(request): Json<ImportPumpRequest>,
) -> Json<serde_json::Value> {
    // Each `import_cycle` tick walks at most `max_pages_per_project`
    // pages across every runnable row; we issue it here scoped to the
    // requested project's runnable state. The scheduler is shared, so
    // a single-project run is what the e2e harness needs.
    let _slug = request.slug.clone();
    let _adapter = request.adapter_id.clone();
    let cap = request.max_pages.unwrap_or(1);
    let result = sync::worker::import_cycle(cap as usize).await;
    match result {
        Ok(()) => Json(json!({ "ok": true, "max_pages": cap })),
        Err(err) => err_json(err),
    }
}

/// Mark the import for `(slug, adapter_id)` as `cancelled`. Mirrors
/// `project_sync_import_cancel`. Idempotent against rows already in
/// terminal state.
pub async fn test_sync_import_cancel(
    Json(request): Json<SlugAdapterRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = sync::io::conn()?;
        sync_import::mark_cancelled(&conn, &slug, &adapter_id, now_ms())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(json!({ "ok": true })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Reset a `failed` row back to `pending` so the next import_pump
/// picks it up. Mirrors `project_sync_import_retry`. Returns
/// `transitioned: false` when the row wasn't `Failed`.
pub async fn test_sync_import_retry(
    Json(request): Json<SlugAdapterRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let conn = sync::io::conn()?;
        sync_import::reset_for_retry(&conn, &slug, &adapter_id, now_ms())
    })
    .await;
    match result {
        Ok(Ok(transitioned)) => Json(json!({ "ok": true, "transitioned": transitioned })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Force a `failed` state on the import row by injecting an error.
/// Used by retry-after-failure scenarios — the echo adapter's
/// `pull_all` is deterministically successful, so we synthesize the
/// failure via this debug endpoint rather than introducing an Echo
/// flag that would never have a production caller.
pub async fn test_sync_import_force_fail(
    Json(request): Json<SlugAdapterRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = sync::io::conn()?;
        sync_import::mark_failed(&conn, &slug, &adapter_id, "e2e_force_fail", now_ms())
    })
    .await;
    match result {
        Ok(Ok(())) => Json(json!({ "ok": true })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

// ============================================================================
// outbox_conflicts debug surface
// ============================================================================

/// Insert (or upsert) a synthetic work item plus per-field local-source
/// `FieldRevision`s and an `external_refs[adapter_id] = external_id`
/// binding.
///
/// The seeded watermark is `(mtime = local_mtime_ms, source = "local")`
/// for both `title` and `status`. A subsequent
/// `inject-merge-external` call whose `remote_updated_at_ms` is
/// strictly less than `local_mtime_ms` will trip the field-level
/// resolver into "keep local" — which is the precondition
/// `conflict_log::detect_conflicts` needs to record an audit row.
pub async fn test_sync_conflict_seed_work_item(
    Json(request): Json<ConflictSeedWorkItemRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let adapter_id = request.adapter_id.clone();
    let short_id = request.short_id.clone();
    let external_id = request.external_id.clone();
    let title = request.title.clone();
    let status = request.status.clone();
    let local_mtime = request.local_mtime_ms;

    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Step 1: write the work item itself. The Frontmatter `id`
        // doubles as the row primary key in `workitems`, so we
        // construct a deterministic id from the slug + short_id pair
        // for re-runs of the same scenario.
        let frontmatter = WorkItemFrontmatter {
            id: format!("{}-{}", slug, short_id),
            short_id: short_id.clone(),
            title,
            project: Some(slug.clone()),
            status,
            priority: "none".to_string(),
            assignee: None,
            assignee_type: None,
            labels: Vec::new(),
            milestone: None,
            parent: None,
            stage: None,
            start_date: None,
            target_date: None,
            created_by: None,
            origin_session: None,
            created_at: String::new(),
            updated_at: String::new(),
            deleted_at: None,
            starred: false,
            todos: Vec::new(),
            comments: Vec::new(),
            history: Vec::new(),
            delegations: Vec::new(),
            linked_sessions: Vec::new(),
            handoff: None,
            proof_of_work: None,
            orchestrator_config: None,
            orchestrator_state: None,
            follow_up_items: Vec::new(),
            schedule: None,
            routine_source: None,
            execution_lock: None,
            close_out: None,
            work_products: Vec::new(),
        };
        write_work_item(&slug, &short_id, &frontmatter, "")?;

        // Step 2: stamp the per-field watermark to (`local`, `local_mtime`)
        // and bind the external_ref so the merge resolver can identity-
        // match on the next `inject-merge-external` call.
        let mut revisions = std::collections::HashMap::new();
        revisions.insert(
            "title".to_string(),
            FieldRevision {
                mtime: local_mtime,
                source: REVISION_SOURCE_LOCAL.to_string(),
            },
        );
        revisions.insert(
            "status".to_string(),
            FieldRevision {
                mtime: local_mtime,
                source: REVISION_SOURCE_LOCAL.to_string(),
            },
        );
        apply_remote_merge(
            &slug,
            &short_id,
            revisions,
            Some((adapter_id.clone(), external_id.clone())),
        )?;
        Ok(())
    })
    .await;

    match result {
        Ok(Ok(())) => Json(json!({
            "ok": true,
            "slug": request.slug,
            "short_id": request.short_id,
            "external_id": request.external_id,
        })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Append one `merge_external` outbox row carrying an `ExternalChange`
/// payload. The merge cycle (drained via `/test/sync/conflict/pump-merge`)
/// will run the resolver against the seeded local watermark and record
/// an `outbox_conflicts` row when the resolver's verdict is "keep local".
pub async fn test_sync_conflict_inject_merge_external(
    Json(request): Json<ConflictInjectMergeRequest>,
) -> Json<serde_json::Value> {
    let slug = request.slug.clone();
    let external_id = request.external_id.clone();
    let remote_updated_at_ms = request.remote_updated_at_ms;
    let remote_fields = request.remote_fields.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<i64, String> {
        // Build the `ExternalChange` payload byte-for-byte the same
        // way the pull cycle does — `serde_json::to_string` then
        // store it as the outbox row's `payload_json`.
        let change = ExternalChange {
            entity_type: EntityType::WorkItem,
            external_id,
            local_entity_id: None,
            fields: remote_fields,
            remote_updated_at: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                remote_updated_at_ms,
            )
            .ok_or_else(|| format!("remote_updated_at_ms={} out of range", remote_updated_at_ms))?,
            deleted: false,
        };
        let payload_json = serde_json::to_string(&change)
            .map_err(|err| format!("ExternalChange serialize: {}", err))?;
        let entry = OutboxEntry {
            id: None,
            project_slug: slug.clone(),
            entity_type: EntityType::WorkItem,
            entity_id: change.external_id.clone(),
            op: OutboxOp::MergeExternal,
            field_path: None,
            payload_json,
            created_at: now_ms(),
            retry_count: 0,
            last_attempted_at: None,
            last_error: None,
            status: OutboxStatus::Pending,
        };
        let conn = sync::io::conn()?;
        sync::io::append(&conn, &entry)
    })
    .await;

    match result {
        Ok(Ok(id)) => Json(json!({ "ok": true, "id": id })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Drive `merge_cycle(N)` so the worker drains pending `merge_external`
/// rows synchronously without waiting for the background tick. Default
/// cap of 8 mirrors `process_merge_entry`-friendly batch sizes elsewhere
/// in the codebase.
pub async fn test_sync_conflict_pump_merge(
    Json(_request): Json<SlugOnlyRequest>,
) -> Json<serde_json::Value> {
    match sync::worker::merge_cycle(8).await {
        Ok(processed) => Json(json!({ "ok": true, "processed": processed })),
        Err(err) => err_json(err),
    }
}

/// `Vec<ConflictRow>` for `slug` — open rows first (newest first) then
/// up to 25 recently-resolved. Wraps the same code path the
/// `project_sync_conflicts_list` Tauri command uses.
pub async fn test_sync_conflict_list(
    axum::extract::Query(query): axum::extract::Query<SlugQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let conn = sync::io::conn()?;
        let rows = conflict_log::list_for_project(&conn, &slug, 25)?;
        let value = serde_json::to_value(&rows)
            .map_err(|err| format!("serialize conflict rows: {}", err))?;
        Ok(value)
    })
    .await;
    match result {
        Ok(Ok(rows)) => Json(json!({ "ok": true, "rows": rows })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}

/// Resolve a conflict by re-pushing local values. Wraps
/// `project_sync_conflict_use_local` so the e2e harness exercises the
/// exact code path the Conflicts panel does.
pub async fn test_sync_conflict_use_local(
    Json(request): Json<ConflictIdRequest>,
) -> Json<serde_json::Value> {
    match sync_commands::project_sync_conflict_use_local(request.conflict_id).await {
        Ok(()) => Json(json!({ "ok": true, "conflict_id": request.conflict_id })),
        Err(err) => err_json(err),
    }
}

/// Resolve a conflict by overwriting local with the captured remote
/// values. Wraps `project_sync_conflict_use_remote`.
pub async fn test_sync_conflict_use_remote(
    Json(request): Json<ConflictIdRequest>,
) -> Json<serde_json::Value> {
    match sync_commands::project_sync_conflict_use_remote(request.conflict_id).await {
        Ok(()) => Json(json!({ "ok": true, "conflict_id": request.conflict_id })),
        Err(err) => err_json(err),
    }
}

/// Dismiss a conflict (close the audit row, no field changes). Wraps
/// `project_sync_conflict_dismiss`.
pub async fn test_sync_conflict_dismiss(
    Json(request): Json<ConflictIdRequest>,
) -> Json<serde_json::Value> {
    match sync_commands::project_sync_conflict_dismiss(request.conflict_id).await {
        Ok(()) => Json(json!({ "ok": true, "conflict_id": request.conflict_id })),
        Err(err) => err_json(err),
    }
}

/// Read back a work item's hot fields so scenarios can assert that
/// `use_remote` actually rewrote the local state. Returns the title +
/// status in a stable wire shape; field labels match the
/// `WorkItemData` accessor names.
#[derive(Debug, Deserialize)]
pub struct ConflictReadWorkItemQuery {
    slug: String,
    short_id: String,
}

pub async fn test_sync_conflict_read_work_item(
    axum::extract::Query(query): axum::extract::Query<ConflictReadWorkItemQuery>,
) -> Json<serde_json::Value> {
    let slug = query.slug.clone();
    let short_id = query.short_id.clone();
    let result = tokio::task::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let item = read_work_item(&slug, &short_id)?;
        Ok(json!({
            "title": item.frontmatter.title,
            "status": item.frontmatter.status,
        }))
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(json!({ "ok": true, "item": value })),
        Ok(Err(err)) => err_json(err),
        Err(join) => err_json(format!("join error: {}", join)),
    }
}
