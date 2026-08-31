use std::collections::HashMap;

use tracing::{debug, info, warn};

use super::{events, finalize_failure, finalize_success, io, now_ms};
use crate::projects::io::{
    allocate_short_id, apply_remote_merge, find_by_external_ref, purge_work_item, read_labels,
    read_members, read_project, read_sync_metadata, read_work_item,
    update_work_item_partial_with_revisions, write_labels, write_members, write_work_item,
    FieldRevision, SyncMetadata,
};
use crate::projects::types::work_items::{default_priority, default_status};
use crate::projects::types::{
    LabelEntry, LabelsFile, MemberEntry, MembersFile, WorkItemData, WorkItemFrontmatter,
    WorkItemPartialUpdate,
};
use crate::sync::adapter::ExternalChange;
use crate::sync::events::SyncEventTrigger;
use crate::sync::types::{EntityType, OutboxEntry};
use crate::sync::{adapters, conflict, conflict_log};

/// One merge cycle: drain up to `max_merges` `merge_external` rows,
/// run the resolver, apply the verdict, mark each row succeeded /
/// failed.
///
/// `merge_external` rows are produced by the pull cycle; the push
/// cycle's `claim_next_pending` filters them out so the queues don't
/// overlap. This cycle is the sole consumer.
pub async fn merge_cycle(max_merges: usize) -> Result<usize, String> {
    let mut processed = 0;
    for _ in 0..max_merges {
        let claimed = claim_one_merge().await?;
        let Some(entry) = claimed else { break };
        process_merge_entry(entry).await?;
        processed += 1;
    }
    Ok(processed)
}

/// Atomically claim the next eligible `merge_external` row. Mirror
/// of the push claim path for the resolver path.
async fn claim_one_merge() -> Result<Option<OutboxEntry>, String> {
    tokio::task::spawn_blocking(|| {
        let conn = io::conn()?;
        io::claim_next_merge_external(&conn, now_ms())
    })
    .await
    .map_err(|err| format!("merge claim join error: {}", err))?
}

async fn process_merge_entry(entry: OutboxEntry) -> Result<(), String> {
    let id = entry
        .id
        .ok_or_else(|| "merge_external entry missing id after claim".to_string())?;

    // Wrap the inner body so we emit one `orgii-project-sync-status`
    // per merge_external row, regardless of which arm finalized it.
    let event_slug = entry.project_slug.clone();
    let result = process_merge_entry_inner(entry, id).await;
    events::emit_status(&event_slug, SyncEventTrigger::MergeCycle);
    result
}

async fn process_merge_entry_inner(entry: OutboxEntry, id: i64) -> Result<(), String> {
    // Locate the adapter for this project. Same lookup the push path
    // uses; if the project is now `'none'` (user detached the adapter
    // between pull and merge), we mark the row succeeded as a no-op.
    let project_slug = entry.project_slug.clone();
    let binding = tokio::task::spawn_blocking({
        let slug = project_slug.clone();
        move || {
            let conn = io::conn()?;
            io::read_adapter_binding(&conn, &slug)
        }
    })
    .await
    .map_err(|err| format!("merge read-binding join error: {}", err))??;

    let Some(binding) = binding else {
        debug!(
            "[sync::worker] merge skipped id={}: project '{}' detached",
            id, project_slug
        );
        return finalize_success(id).await;
    };
    let adapter_id = binding.adapter_id;

    let Some(adapter) = adapters::get(&adapter_id) else {
        return finalize_failure(
            id,
            &format!("adapter '{}' not registered", adapter_id),
            /* retryable= */ false,
        )
        .await;
    };

    // The pull cycle serializes `ExternalChange` directly into
    // `payload_json`. Round-tripping back through serde keeps that the
    // single source of truth.
    let change: ExternalChange = match serde_json::from_str(&entry.payload_json) {
        Ok(value) => value,
        Err(err) => {
            return finalize_failure(
                id,
                &format!("malformed merge_external payload: {}", err),
                /* retryable= */ false,
            )
            .await;
        }
    };

    // Identify the local work item. Two ways:
    // 1. The pull side already filled in `local_entity_id` (a future
    //    optimization — none of the current adapters do this). We
    //    trust it and skip the lookup.
    // 2. Fall back to scanning `workitem_extras.external_refs` for
    //    `(adapter_id, change.external_id)`.
    let lookup_slug = project_slug.clone();
    let lookup_adapter = adapter_id.clone();
    let lookup_external = change.external_id.clone();
    let pre_resolved = change.local_entity_id.clone();
    let short_id = tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        if let Some(id) = pre_resolved {
            return Ok(Some(id));
        }
        find_by_external_ref(&lookup_slug, &lookup_adapter, &lookup_external)
    })
    .await
    .map_err(|err| format!("merge lookup join error: {}", err))??;

    let preferred_short_id = adapter.preferred_work_item_short_id(&change.external_id);
    let Some(mut short_id) = short_id else {
        // No local item bound to this external_id.
        if change.deleted {
            // The remote was created and removed before we ever
            // saw it. Nothing to do — succeed silently.
            debug!(
                "[sync::worker] merge id={}: external_id={} deleted before first pull, no-op",
                id, change.external_id
            );
            return finalize_success(id).await;
        }
        return apply_inbound_create(id, &project_slug, &adapter_id, &change, preferred_short_id)
            .await;
    };

    if let Some(preferred_short_id) = preferred_short_id {
        if preferred_short_id != short_id {
            let rename_slug = project_slug.clone();
            let rename_current = short_id.clone();
            let rename_preferred = preferred_short_id.clone();
            short_id = tokio::task::spawn_blocking(move || {
                super::identity::rename_work_item_short_id(
                    &rename_slug,
                    &rename_current,
                    &rename_preferred,
                )
            })
            .await
            .map_err(|err| format!("merge short-id rename join error: {err}"))??;
        }
    }

    if change.deleted {
        return apply_remote_delete(id, &project_slug, &short_id, &change.external_id).await;
    }

    let catalog_slug = project_slug.clone();
    let catalog_fields = change.fields.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let project_id = read_project(&catalog_slug)?.meta.id;
        upsert_remote_catalog_entries(&project_id, &catalog_fields)
    })
    .await
    .map_err(|err| format!("merge catalog join error: {}", err))??;

    // Resolve. Read the metadata + the local view of the work item
    // (both feed the resolver: metadata drives the merge decision and
    // the local view is required for field-level conflict detection),
    // run the (sync) resolver, capture the verdict. We use `resolve`
    // — the trait-default tie-break is `UseRemote`, matching the
    // design doc.
    let metadata_slug = project_slug.clone();
    let metadata_short_id = short_id.clone();
    let (metadata, local_view) =
        tokio::task::spawn_blocking(move || -> Result<(SyncMetadata, WorkItemData), String> {
            let meta =
                read_sync_metadata(&metadata_slug, &metadata_short_id)?.ok_or_else(|| {
                    format!(
                        "work item '{}' disappeared between lookup and merge",
                        metadata_short_id
                    )
                })?;
            let view = read_work_item(&metadata_slug, &metadata_short_id)?;
            Ok((meta, view))
        })
        .await
        .map_err(|err| format!("merge metadata join error: {}", err))??;

    let decision = conflict::resolve(&change, &metadata, adapter.as_ref());

    // Surface field-level conflicts for the user to resolve.
    // The resolver has already produced its verdict above (and we
    // honour it below). Detection runs purely on the same inputs so
    // the row we persist matches what the resolver actually applied.
    let local_values = local_values_for_field_map(&local_view, adapter.entity_field_map());
    let conflict_payload = conflict_log::detect_conflicts(
        &change,
        &metadata,
        adapter.entity_field_map(),
        &local_values,
        &adapter_id,
    );
    if !conflict_payload.fields.is_empty() {
        let log_slug = project_slug.clone();
        let log_adapter = adapter_id.clone();
        let log_short_id = short_id.clone();
        let log_external = change.external_id.clone();
        let payload_clone = conflict_payload.clone();
        let detected_at = now_ms();
        // Best-effort: a failed audit log row must not block the
        // resolver from applying the verdict — we want forward
        // progress even when bookkeeping hiccups. We still bubble
        // join errors so a panicking blocking task doesn't pass
        // silently.
        let log_result = tokio::task::spawn_blocking(move || -> Result<i64, String> {
            conflict_log::record_detected(
                &*io::conn()?,
                &log_slug,
                &log_adapter,
                EntityType::WorkItem,
                &log_short_id,
                &log_external,
                &payload_clone,
                detected_at,
                Some(id),
            )
        })
        .await
        .map_err(|err| format!("conflict-log join error: {}", err))?;
        match log_result {
            Ok(row_id) => debug!(
                "[sync::worker] merge id={}: logged conflict row={} fields={}",
                id,
                row_id,
                conflict_payload.fields.len()
            ),
            Err(err) => warn!(
                "[sync::worker] merge id={}: conflict-log persist failed: {}",
                id, err
            ),
        }
    }

    // The resolver normally only sets `is_delete` on tombstone changes,
    // which we've already short-circuited above. This branch should
    // therefore be unreachable in practice — guard it anyway so a
    // future resolver hook that flips the bit doesn't fall through to
    // the field-merge path with `is_delete = true`.
    if decision.is_delete {
        return apply_remote_delete(id, &project_slug, &short_id, &change.external_id).await;
    }

    let creator_backfill = build_creator_backfill_update(&local_view, &change.fields);
    let has_creator_backfill = creator_backfill.created_by.is_some();

    if decision.adopted_fields.is_empty() && !has_creator_backfill {
        debug!(
            "[sync::worker] merge id={}: no adopted fields ({} kept_local)",
            id,
            decision.kept_local.len()
        );
        // Even with nothing adopted, we still want the external_ref
        // recorded so subsequent merges have an identity anchor —
        // `apply_remote_merge` accepts an empty revision map.
        let stamp_slug = project_slug.clone();
        let stamp_short_id = short_id.clone();
        let stamp_adapter = adapter_id.clone();
        let stamp_external = change.external_id.clone();
        tokio::task::spawn_blocking(move || {
            apply_remote_merge(
                &stamp_slug,
                &stamp_short_id,
                HashMap::new(),
                Some((stamp_adapter, stamp_external)),
            )
        })
        .await
        .map_err(|err| format!("merge stamp join error: {}", err))??;
        return finalize_success(id).await;
    }

    // Apply. The field write and the per-field watermark stamp run
    // inside the same SQLite transaction via
    // `update_work_item_partial_with_revisions`, so a worker crash
    // between the two can never leave a half-stamped state. The
    // `apply_remote_merge` call that follows only records the
    // `external_refs` binding — its inconsistency window (no binding
    // until commit, fields already written) is benign because
    // `external_refs` is consulted only by future pulls, not by the
    // resolver of this change.
    let mut update = build_partial_update(&decision);
    if let Some(created_by) = creator_backfill.created_by {
        update.created_by = Some(created_by);
    }
    let mut decision = decision;
    let new_revisions = std::mem::take(&mut decision.new_revisions);
    let apply_slug = project_slug.clone();
    let apply_short_id = short_id.clone();
    let apply_adapter_id = adapter_id.clone();
    let apply_external_id = change.external_id.clone();

    let outcome = tokio::task::spawn_blocking(move || -> Result<(), String> {
        update_work_item_partial_with_revisions(
            &apply_slug,
            &apply_short_id,
            new_revisions,
            &update,
        )?;
        apply_remote_merge(
            &apply_slug,
            &apply_short_id,
            HashMap::new(),
            Some((apply_adapter_id, apply_external_id)),
        )?;
        Ok(())
    })
    .await
    .map_err(|err| format!("merge apply join error: {}", err))?;

    match outcome {
        Ok(()) => {
            debug!(
                "[sync::worker] merge id={} applied: adopted={} kept_local={}",
                id,
                decision.adopted_fields.len(),
                decision.kept_local.len()
            );
            finalize_success(id).await
        }
        Err(err) => {
            warn!("[sync::worker] merge id={} apply failed: {}", id, err);
            finalize_failure(id, &err, /* retryable= */ true).await
        }
    }
}

/// Apply a "create-from-remote" merge: use the adapter's canonical short id
/// when it has one, otherwise allocate a new local short id; materialize a
/// fresh work item from the inbound `change.fields`, and
/// stamp the `(adapter_id, external_id)` binding plus per-field
/// watermarks so subsequent inbound updates target the same row.
///
/// The two-call layout (write then stamp) mirrors the update path.
/// A worker crash between the calls leaves the new item in the local
/// store with no `external_refs` entry, which is recovered on the
/// next pull cycle (the adapter re-emits the same `external_id` and
/// the lookup-by-external-ref path will fail to match, producing a
/// duplicate). To bound that risk we order the stamp call as the
/// first thing after the write — same blocking task, no awaits in
/// between — so the window is one SQLite commit wide.
async fn apply_inbound_create(
    id: i64,
    project_slug: &str,
    adapter_id: &str,
    change: &ExternalChange,
    preferred_short_id: Option<String>,
) -> Result<(), String> {
    let create_slug = project_slug.to_string();
    let create_adapter = adapter_id.to_string();
    let create_external = change.external_id.clone();
    let create_fields = change.fields.clone();
    let create_preferred_short_id = preferred_short_id;
    let remote_mtime_ms = change.remote_updated_at.timestamp_millis();

    let outcome = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let uses_external_short_id = create_preferred_short_id.is_some();
        let short_id = match create_preferred_short_id {
            Some(short_id) => short_id,
            None => allocate_short_id(&create_slug)?,
        };
        // `workitems.id` is the private relational identity and must remain
        // globally unique even when two GitHub repositories both have #42.
        // Existing project-allocated items retain their historical id shape.
        let work_item_id = if uses_external_short_id {
            format!(
                "sync:{}:{}:{}",
                create_adapter, create_slug, create_external
            )
        } else {
            short_id.clone()
        };
        let project_id = read_project(&create_slug)?.meta.id;
        upsert_remote_catalog_entries(&project_id, &create_fields)?;
        let (frontmatter, body) =
            build_inbound_create_frontmatter(&work_item_id, &short_id, &create_fields);
        write_work_item(&create_slug, &short_id, &frontmatter, &body)?;

        let revisions =
            build_inbound_create_revisions(&create_fields, &create_adapter, remote_mtime_ms);
        apply_remote_merge(
            &create_slug,
            &short_id,
            revisions,
            Some((create_adapter, create_external)),
        )?;
        Ok(short_id)
    })
    .await
    .map_err(|err| format!("inbound create join error: {}", err))?;

    match outcome {
        Ok(short_id) => {
            info!(
                "[sync::worker] merge id={} created local item {} from {}::{}",
                id, short_id, adapter_id, change.external_id
            );
            finalize_success(id).await
        }
        Err(err) => {
            warn!("[sync::worker] merge id={} create failed: {}", id, err);
            finalize_failure(id, &err, /* retryable= */ true).await
        }
    }
}

/// Apply a remote-driven delete: hard-delete the local work item.
/// `workitem_extras` and `workitem_labels` cascade off `workitems` via
/// `ON DELETE CASCADE`, so the external_ref vanishes with the item —
/// no separate cleanup needed.
///
/// We chose hard-delete over soft-delete (a "trash" tab) because:
/// - The local store has no notion of soft-delete today; adding it
///   for sync alone would carry into every list view and create a UX
///   surface that the design doc hasn't authorized.
/// - Filesystem-level recovery (the projects.db is in `~/.orgii/`,
///   user-writable) is the supported escape hatch for accidental
///   remote deletes.
async fn apply_remote_delete(
    id: i64,
    project_slug: &str,
    short_id: &str,
    external_id: &str,
) -> Result<(), String> {
    let delete_slug = project_slug.to_string();
    let delete_short_id = short_id.to_string();
    let outcome = tokio::task::spawn_blocking(move || -> Result<(), String> {
        purge_work_item(&delete_slug, &delete_short_id)
    })
    .await
    .map_err(|err| format!("remote delete join error: {}", err))?;

    match outcome {
        Ok(()) => {
            info!(
                "[sync::worker] merge id={}: hard-deleted local item {} (remote {})",
                id, short_id, external_id
            );
            finalize_success(id).await
        }
        Err(err) => {
            // `delete_work_item` returns `Err` when the row is already
            // gone — the resolver consulted `find_by_external_ref`
            // before reaching here, so a concurrent local delete is
            // the only path that triggers this. Treat as success since
            // the post-condition (no local item) is what we wanted.
            if err.contains("not found") {
                debug!(
                    "[sync::worker] merge id={}: local item {} already gone, no-op",
                    id, short_id
                );
                finalize_success(id).await
            } else {
                warn!("[sync::worker] merge id={}: delete failed: {}", id, err);
                finalize_failure(id, &err, /* retryable= */ true).await
            }
        }
    }
}

/// Construct a [`WorkItemFrontmatter`] (and its accompanying body) for
/// a freshly allocated short_id from an inbound `change.fields`
/// payload. Missing fields fall back to system defaults
/// (`status="backlog"`, `priority="none"`, empty labels) so the work
/// item is queryable through the standard read path the moment the
/// row commits.
fn build_creator_backfill_update(
    local_view: &WorkItemData,
    fields: &serde_json::Value,
) -> WorkItemPartialUpdate {
    let mut update = WorkItemPartialUpdate::default();
    if local_view
        .frontmatter
        .created_by
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return update;
    }
    let Some(created_by) = fields
        .get("created_by")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return update;
    };
    update.created_by = Some(created_by.to_string());
    update
}

fn build_inbound_create_frontmatter(
    work_item_id: &str,
    short_id: &str,
    fields: &serde_json::Value,
) -> (WorkItemFrontmatter, String) {
    let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let object = fields.as_object();
    let pick_string = |key: &str| {
        object
            .and_then(|obj| obj.get(key))
            .and_then(|value| value.as_str())
            .map(str::to_string)
    };
    let labels: Vec<String> = object
        .and_then(|obj| obj.get("labels"))
        .and_then(|value| value.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let frontmatter = WorkItemFrontmatter {
        id: work_item_id.to_string(),
        short_id: short_id.to_string(),
        title: pick_string("title").unwrap_or_default(),
        project: None,
        status: pick_string("status").unwrap_or_else(default_status),
        priority: pick_string("priority").unwrap_or_else(default_priority),
        assignee: pick_string("assignee"),
        assignee_type: None,
        labels,
        milestone: pick_string("milestone"),
        parent: None,
        stage: None,
        start_date: pick_string("start_date"),
        target_date: pick_string("target_date"),
        created_by: pick_string("created_by"),
        origin_session: None,
        created_at: now_iso.clone(),
        updated_at: now_iso,
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        handoff: None,
        linked_sessions: vec![],
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    };

    let body = pick_string("body").unwrap_or_default();
    (frontmatter, body)
}

fn upsert_remote_catalog_entries(
    project_id: &str,
    fields: &serde_json::Value,
) -> Result<(), String> {
    upsert_remote_labels(project_id, fields)?;
    upsert_remote_members(project_id, fields)?;
    Ok(())
}

fn upsert_remote_labels(project_id: &str, fields: &serde_json::Value) -> Result<(), String> {
    let Some(label_nodes) = fields
        .get("label_details")
        .and_then(|value| value.as_array())
    else {
        return Ok(());
    };

    let mut labels = read_labels(project_id)?.labels;
    for label_node in label_nodes {
        let Some(name) = label_node.get("name").and_then(|value| value.as_str()) else {
            continue;
        };
        let color =
            normalize_github_color(label_node.get("color").and_then(|value| value.as_str()));
        match labels.iter_mut().find(|entry| entry.id == name) {
            Some(existing) => {
                existing.name = name.to_string();
                existing.color = color;
            }
            None => labels.push(LabelEntry {
                id: name.to_string(),
                name: name.to_string(),
                color,
            }),
        }
    }
    write_labels(project_id, &LabelsFile { labels })
}

fn upsert_remote_members(project_id: &str, fields: &serde_json::Value) -> Result<(), String> {
    let mut member_nodes = Vec::new();
    if let Some(assignee_nodes) = fields
        .get("assignee_details")
        .and_then(|value| value.as_array())
    {
        member_nodes.extend(assignee_nodes.iter());
    }
    if let Some(creator_node) = fields.get("creator_details") {
        member_nodes.push(creator_node);
    }
    if member_nodes.is_empty() {
        return Ok(());
    }

    let mut members = read_members(project_id)?.members;
    for member_node in member_nodes {
        let Some(login) = member_node.get("login").and_then(|value| value.as_str()) else {
            continue;
        };
        let avatar = member_node
            .get("avatar_url")
            .and_then(|value| value.as_str())
            .map(str::to_string);
        match members.iter_mut().find(|entry| entry.id == login) {
            Some(existing) => {
                existing.name = login.to_string();
                existing.github_username = Some(login.to_string());
                existing.avatar = avatar;
                existing.active = true;
            }
            None => members.push(MemberEntry {
                id: login.to_string(),
                name: login.to_string(),
                email: None,
                avatar,
                github_username: Some(login.to_string()),
                last_commit_date: None,
                active: true,
            }),
        }
    }
    write_members(project_id, &MembersFile { members })
}

fn normalize_github_color(color: Option<&str>) -> String {
    let Some(raw_color) = color.map(str::trim).filter(|value| !value.is_empty()) else {
        return "#6b7280".to_string();
    };
    if raw_color.starts_with('#') {
        raw_color.to_string()
    } else {
        format!("#{raw_color}")
    }
}

/// Build the per-field watermark map for an inbound-create. Every
/// sync-tracked field that the inbound payload carries gets a fresh
/// [`FieldRevision`] sourced from the adapter at `remote_mtime_ms`.
/// Fields the payload omits stay unstamped — a future inbound that
/// includes them will set the watermark on first sight.
fn build_inbound_create_revisions(
    fields: &serde_json::Value,
    adapter_id: &str,
    remote_mtime_ms: i64,
) -> HashMap<String, FieldRevision> {
    const TRACKED: &[&str] = &[
        "title",
        "body",
        "status",
        "priority",
        "assignee",
        "milestone",
        "start_date",
        "target_date",
        "labels",
    ];
    let object = match fields.as_object() {
        Some(obj) => obj,
        None => return HashMap::new(),
    };
    let mut revisions = HashMap::new();
    for field in TRACKED {
        if object.contains_key(*field) {
            revisions.insert(
                (*field).to_string(),
                FieldRevision {
                    mtime: remote_mtime_ms,
                    source: adapter_id.to_string(),
                },
            );
        }
    }
    revisions
}

use super::merge_helpers::{build_partial_update, local_values_for_field_map};
