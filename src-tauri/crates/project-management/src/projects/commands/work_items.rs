//! Work item commands: reads, writes, atomic patches, and batch ops.
//!
//! The shape of every command intentionally mirrors the legacy
//! `project_*_work_item*` surface so a frontend rename is the
//! only migration needed. The functional differences:
//!
//! - No `repo_path` parameter — work items are global rows keyed by
//!   `(project_slug, short_id)`.
//! - `project_update_work_item_partial` calls the *enriched* IO
//!   variant so the wire shape stays `EnrichedWorkItem`, matching
//!   what the WorkItems page already consumes from the legacy
//!   command. Keeping enrichment server-side preserves the
//!   single-IPC contract the page was built around.
//! - `project_allocate_work_item_id` takes a required `project_slug`
//!   (the legacy command tolerated `None` and fell back to a default
//!   project). Every frontend call site already passes a slug, so
//!   the new contract reflects actual usage.

use super::super::io;
use super::super::types::{
    BatchDeleteResult, BatchUpdateResult, EnrichedWorkItem, WorkItemData, WorkItemFrontmatter,
    WorkItemPartialUpdate, WorkItemReadBucket, WorkItemsViewData,
};

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

/// Read every work item for `project_slug` as raw `WorkItemData`
/// (frontmatter + body, no resolution). Use the `_enriched` /
/// `_view_data` variants when rendering UI; this one is for code
/// paths that need the unresolved YAML (export, sync, agent tools).
#[tauri::command]
pub async fn project_read_work_items(
    project_slug: String,
    org_id: Option<String>,
) -> Result<Vec<WorkItemData>, String> {
    tokio::task::spawn_blocking(move || {
        io::read_all_work_items_scoped(&project_slug, org_id.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Read every work item with labels and members pre-resolved into
/// full objects. Replaces three IPC calls (`read_work_items` +
/// `read_labels` + `read_members`) and a JS-side resolution loop
/// with a single rusqlite handoff.
#[tauri::command]
pub async fn project_read_work_items_enriched(
    project_slug: String,
    org_id: Option<String>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<EnrichedWorkItem>, String> {
    tokio::task::spawn_blocking(move || {
        io::read_all_work_items_enriched_scoped_filtered(
            &project_slug,
            org_id.as_deref(),
            read_bucket,
        )
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// One-shot endpoint for the WorkItems page: enriched items + status
/// counts (computed BEFORE filtering, for the filter badges) +
/// Kanban / Gantt / Calendar projections + items grouped by status.
///
/// Optional `status_filter` and `search_query` are applied
/// server-side so we don't ship items the UI is going to discard
/// across the IPC boundary.
#[tauri::command]
pub async fn project_read_work_items_view_data(
    project_slug: String,
    org_id: Option<String>,
    status_filter: Option<String>,
    search_query: Option<String>,
) -> Result<WorkItemsViewData, String> {
    tokio::task::spawn_blocking(move || {
        io::read_work_items_view_data_scoped(
            &project_slug,
            org_id.as_deref(),
            status_filter.as_deref(),
            search_query.as_deref(),
        )
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Read a single work item by `(project_slug, short_id)`.
#[tauri::command]
pub async fn project_read_work_item(
    project_slug: String,
    short_id: String,
    org_id: Option<String>,
) -> Result<WorkItemData, String> {
    tokio::task::spawn_blocking(move || {
        io::read_work_item_scoped(&project_slug, &short_id, org_id.as_deref())
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn work_item_read_standalone_items(
    org_id: Option<String>,
    read_bucket: Option<WorkItemReadBucket>,
) -> Result<Vec<WorkItemData>, String> {
    tokio::task::spawn_blocking(move || {
        io::read_standalone_work_items_filtered(org_id.as_deref(), read_bucket)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn work_item_read_standalone_item(
    org_id: Option<String>,
    short_id: String,
) -> Result<WorkItemData, String> {
    tokio::task::spawn_blocking(move || io::read_standalone_work_item(org_id.as_deref(), &short_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

/// Create or update a work item with full frontmatter + body.
///
/// This is the "blunt" upsert — the entire frontmatter is replaced.
/// For incremental edits (status flip, single-field change), use
/// `project_update_work_item_partial`, which holds an `IMMEDIATE`
/// transaction across read-modify-write to avoid the lost-update
/// race this command can produce under concurrent edits.
#[tauri::command]
pub async fn project_write_work_item(
    project_slug: String,
    short_id: String,
    frontmatter: WorkItemFrontmatter,
    body: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        io::write_work_item(&project_slug, &short_id, &frontmatter, &body)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn work_item_write_standalone_item(
    org_id: Option<String>,
    short_id: String,
    frontmatter: WorkItemFrontmatter,
    body: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        io::write_standalone_work_item(org_id.as_deref(), &short_id, &frontmatter, &body)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Delete a work item. FK cascades to `workitem_labels` and
/// `workitem_extras`; assets stay on disk.
#[tauri::command]
pub async fn project_delete_work_item(
    project_slug: String,
    short_id: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || io::delete_work_item(&project_slug, &short_id))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_restore_work_item(
    project_slug: String,
    short_id: String,
) -> Result<EnrichedWorkItem, String> {
    tokio::task::spawn_blocking(move || {
        let restored = io::restore_work_item(&project_slug, &short_id)?;
        io::read_work_item_enriched(&project_slug, &restored.frontmatter.short_id)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn project_purge_expired_deleted_work_items(
    project_slug: String,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || io::purge_expired_deleted_work_items(&project_slug))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Atomic read-modify-write for a single field-set patch. Runs
/// inside a `BEGIN IMMEDIATE` transaction so concurrent partial
/// updates serialize at the SQLite level. Returns the *enriched*
/// view so the caller can update its UI state without a follow-up
/// read.
#[tauri::command]
pub async fn project_update_work_item_partial(
    project_slug: String,
    short_id: String,
    updates: WorkItemPartialUpdate,
) -> Result<EnrichedWorkItem, String> {
    tokio::task::spawn_blocking(move || {
        io::update_work_item_partial_enriched(&project_slug, &short_id, &updates)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}

/// Move a work item from `from_project` to `to_project`. The
/// short_id is preserved (it's globally unique under our prefix
/// scheme), only the foreign key flips.
#[tauri::command]
pub async fn project_move_work_item(
    short_id: String,
    from_project: String,
    to_project: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || io::move_work_item(&short_id, &from_project, &to_project))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Allocate the next `short_id` for a new work item under
/// `project_slug` (e.g. `AAA-0042`). The allocator scans existing
/// IDs inside an `IMMEDIATE` transaction so out-of-band inserts
/// can't collide with the next handout.
#[tauri::command]
pub async fn project_allocate_work_item_id(project_slug: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || io::allocate_short_id(&project_slug))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

#[tauri::command]
pub async fn work_item_allocate_standalone_id(org_id: Option<String>) -> Result<String, String> {
    tokio::task::spawn_blocking(move || io::allocate_standalone_short_id(org_id.as_deref()))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

// ---------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------

/// Delete N work items in one IPC call. Per-item failures are
/// collected, not propagated — the result reports successes and
/// errors separately so a partial-success UX (e.g. "deleted 7 of
/// 10, see errors") stays straightforward.
#[tauri::command]
pub async fn project_batch_delete_work_items(
    project_slug: String,
    short_ids: Vec<String>,
) -> Result<BatchDeleteResult, String> {
    tokio::task::spawn_blocking(move || io::batch_delete_work_items(&project_slug, short_ids))
        .await
        .map_err(|err| format!("Task join error: {}", err))?
}

/// Apply the same partial update to N work items. Lookup maps
/// (labels, members, project name) are built once and reused across
/// every item; each item's RMW still runs in its own atomic
/// transaction so a poison-pill ID doesn't undo the rest of the
/// batch.
#[tauri::command]
pub async fn project_batch_update_work_items(
    project_slug: String,
    short_ids: Vec<String>,
    updates: WorkItemPartialUpdate,
) -> Result<BatchUpdateResult, String> {
    tokio::task::spawn_blocking(move || {
        io::batch_update_work_items(&project_slug, short_ids, updates)
    })
    .await
    .map_err(|err| format!("Task join error: {}", err))?
}
