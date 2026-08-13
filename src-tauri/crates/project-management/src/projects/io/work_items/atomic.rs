//! Atomic read-modify-write for work items.
//!
//! `update_work_item_atomic` opens a `BEGIN IMMEDIATE` transaction (which
//! takes a SQLite RESERVED lock right away, before any read), reads the
//! row, runs the caller's mutator on the deserialized
//! `WorkItemFrontmatter` + body, then writes back inside the same tx and
//! commits. The closure runs exactly once and concurrent writers queue
//! at the SQLite layer — same semantics as the legacy file-based flock,
//! but without a separate `.lock` sidecar file.
//!
//! Note: closures run synchronously inside the tx, so they must NOT call
//! into other DB code that opens its own write tx (deadlock risk on the
//! same DB file). Pure data mutations are the supported shape, matching
//! every existing caller.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::super::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use super::extras::{ExtrasPayload, FieldRevision, REVISION_SOURCE_LOCAL};
use super::history::{append_mutation_event, WorkItemHistorySnapshot};
use crate::projects::types::{WorkItemData, WorkItemFrontmatter, WorkItemPartialUpdate};

#[derive(Debug, Clone, Copy)]
enum AtomicWorkItemScope<'a> {
    Project(&'a str),
    Standalone { org_id: &'a str },
}

/// Work-service options threaded into the atomic RMW choke point
/// (`orgtrack/v1` Phase 2a). Legacy callers use `Default` — no OCC
/// precondition, flag-only FSM validation, generic `work.patch` audit
/// label. The application service (`crate::work_service`) passes explicit
/// options for strict transitions.
#[derive(Default)]
pub struct AtomicServiceOptions {
    /// Optimistic concurrency: reject with `PM_ERR:REVISION_CONFLICT`
    /// when the row's `local_version` differs before the mutator runs.
    pub expected_local_version: Option<i64>,
    /// Canonical operation label for the audit event (default `work.patch`).
    pub operation: Option<&'static str>,
    /// Reject portable-FSM violations instead of recording them as
    /// flagged audit metadata.
    pub strict_fsm: bool,
    /// Human-supplied reason (transition/reopen/release), audited.
    pub reason: Option<String>,
}

/// Sync-relevant fields whose mutations are tracked in
/// `workitem_extras.field_revisions`. The names match
/// [`crate::sync::adapter::EntityField::as_local_name`]
/// so the resolver and the stamper agree on identity. Fields outside
/// this set are local-only (e.g. `todos`, `comments`, `starred`) and
/// never compared against external watermarks.
///
/// This constant is currently consumed only as documentation —
/// [`SyncFieldSnapshot::diff`] inlines the same field set so the
/// per-field comparison can pull from the typed frontmatter instead
/// of going through string lookups. The list is kept here as the
/// canonical reference; if you add a field, update both.
#[allow(dead_code)]
const SYNC_TRACKED_FIELDS: &[&str] = &[
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

/// Atomically read-modify-write a single work item.
///
/// Atomically update one work item row in the project store
/// signature, minus the `repo_path` argument. The closure receives mutable
/// access to both frontmatter and body and may return any value; if it
/// returns `Err`, the transaction rolls back and no change is persisted.
///
/// On success, `local_version` and `updated_at` are both bumped, and any
/// sync-tracked field whose post-mutation value differs from its
/// pre-mutation value (see [`SYNC_TRACKED_FIELDS`]) gets a fresh
/// [`FieldRevision`] stamped with `source = "local"`. Sync metadata
/// (`field_revisions`, `external_refs`) is preserved across the RMW —
/// fields the mutator did not change keep their existing watermark.
///
/// **Outbox emission.** When the project is bound to a sync adapter and
/// at least one sync-tracked field actually changed, this function
/// appends one `OutboxOp::Update` entry to `outbox_entries` so the
/// worker can replay the change against the remote system. Callers
/// running on behalf of an external adapter (the merge cycle) MUST
/// use [`update_work_item_atomic_with_revisions`] instead so the
/// stamps are attributed to the adapter and the change does not bounce
/// back to the originating system.
pub fn update_work_item_atomic<T, F>(
    project_slug: &str,
    short_id: &str,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    update_work_item_atomic_as(project_slug, short_id, None, mutator)
}

/// Actor-attributed variant of [`update_work_item_atomic`].
///
/// This preserves the same outbox/payload-tail behavior while allowing
/// domain commands such as handoff acceptance to write an auditable history
/// event without duplicating the transaction or sync logic.
pub fn update_work_item_atomic_as<T, F>(
    project_slug: &str,
    short_id: &str,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    let (value, changed_fields, payload_tail_changed) = update_work_item_atomic_with_revisions(
        project_slug,
        short_id,
        HashMap::new(),
        actor,
        mutator,
    )?;
    if !changed_fields.is_empty() {
        // Re-read the work item to build the outbox payload. The read
        // is one extra round trip but keeps the closure-form API
        // value-only (callers don't have to thread a payload back out
        // of the mutator). The post-commit window is small enough that
        // a concurrent merge can't race past us — and even if it did,
        // the worst case is a stale field value in the queued payload,
        // which the resolver will catch on the next merge cycle.
        let data = super::crud::read_work_item(project_slug, short_id)?;
        let payload = changed_fields_payload(&data, &changed_fields);
        crate::sync::io::record_local_update(project_slug, short_id, &changed_fields, &payload)?;
    } else if payload_tail_changed {
        // The mutator only touched payload-tail fields (execution_lock,
        // linked_sessions, orchestrator_state, …) — not covered by the
        // sync-tracked diff, but collab-synced orgs still need to push
        // the row: those fields travel in the server payload jsonb
        // (design §16.3). Without this, a local lock acquire/release
        // through this path would never propagate to teammates.
        crate::sync::collab_bridge::record_work_item_payload_touch(project_slug, short_id)?;
    }
    Ok(value)
}

/// Variant of [`update_work_item_atomic`] that lets the caller supply
/// per-field revision overrides and returns the list of changed
/// sync-tracked fields alongside the mutator's value.
///
/// `override_revisions` is the merge cycle's hook: any field present
/// here is stamped with the supplied [`FieldRevision`] regardless of
/// whether the mutator actually changed its value. This is exactly the
/// shape of `ResolverDecision::new_revisions`. Fields **not** in
/// `override_revisions` follow the diff-based local-stamping rule used
/// by [`update_work_item_atomic`].
///
/// `external_ref` is the merge cycle's other hook — when supplied, the
/// `(adapter_id, external_id)` pair is recorded in `external_refs` in
/// the same transaction so the merge becomes one atomic unit (no
/// partial-stamp window between the field write and the identity
/// binding).
///
/// The returned `Vec<&'static str>` contains the canonical names of
/// every sync-tracked field whose post-mutation value differs from its
/// pre-mutation value. The user-driven path ([`update_work_item_partial`])
/// uses this list to emit outbox rows; the merge path ignores it
/// because outbox emission for adapter-applied changes would loop the
/// change back to the originating system.
///
/// The returned `bool` reports whether any payload-tail field (fields
/// that ride only in the collab server's payload jsonb — execution
/// lock, linked sessions, todos, …; see [`payload_tail_fingerprint`])
/// changed. [`update_work_item_atomic`] uses it to enqueue a collab
/// bridge push for tail-only mutations the sync-tracked diff misses.
pub fn update_work_item_atomic_with_revisions<T, F>(
    project_slug: &str,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    mutator: F,
) -> Result<(T, Vec<&'static str>, bool), String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    update_work_item_atomic_with_revisions_scoped(
        AtomicWorkItemScope::Project(project_slug),
        short_id,
        override_revisions,
        actor,
        AtomicServiceOptions::default(),
        mutator,
    )
}

/// Application-service entry: same transactional semantics as
/// [`update_work_item_atomic_as`] (outbox emission included) plus the
/// service options — OCC precondition, strict FSM, audit label/reason.
pub fn update_work_item_atomic_serviced<T, F>(
    project_slug: &str,
    short_id: &str,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    service: AtomicServiceOptions,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    let (value, changed_fields, payload_tail_changed) =
        update_work_item_atomic_with_revisions_scoped(
            AtomicWorkItemScope::Project(project_slug),
            short_id,
            HashMap::new(),
            actor,
            service,
            mutator,
        )?;
    if !changed_fields.is_empty() {
        let data = super::crud::read_work_item(project_slug, short_id)?;
        let payload = changed_fields_payload(&data, &changed_fields);
        crate::sync::io::record_local_update(project_slug, short_id, &changed_fields, &payload)?;
    } else if payload_tail_changed {
        crate::sync::collab_bridge::record_work_item_payload_touch(project_slug, short_id)?;
    }
    Ok(value)
}

/// Closure-form atomic RMW for a standalone (org-scoped) work item —
/// the standalone counterpart to [`update_work_item_atomic`]. Shares the
/// same `BEGIN IMMEDIATE` boundary, history writer, audit + watermark
/// emission, and collab-bridge push as the partial-update path, so
/// callers stop doing client-side read-modify-write + whole-row writes
/// (the lost-update race).
pub fn update_standalone_work_item_atomic<T, F>(
    org_id: Option<&str>,
    short_id: &str,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    update_standalone_work_item_atomic_by(org_id, None, short_id, mutator)
}

pub fn update_standalone_work_item_atomic_by<T, F>(
    org_id: Option<&str>,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    short_id: &str,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    update_standalone_work_item_atomic_serviced(
        org_id,
        actor,
        AtomicServiceOptions::default(),
        short_id,
        mutator,
    )
}

/// Standalone counterpart of [`update_work_item_atomic_serviced`]: same
/// atomic RMW, but the caller stamps the canonical audit operation
/// (e.g. `work.note`) instead of the default `work.patch`.
pub fn update_standalone_work_item_atomic_serviced<T, F>(
    org_id: Option<&str>,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    service: AtomicServiceOptions,
    short_id: &str,
    mutator: F,
) -> Result<T, String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    let org_id = org_id.unwrap_or("personal-org");
    let (value, changed_fields, payload_tail_changed) =
        update_standalone_work_item_atomic_as(org_id, short_id, actor, service, |fm, body| {
            mutator(fm, body)
        })?;
    if !changed_fields.is_empty() || payload_tail_changed {
        let data = super::crud::read_standalone_work_item(Some(org_id), short_id)?;
        crate::sync::collab_bridge::record_work_item_write(
            org_id,
            None,
            &data.frontmatter.id,
            data.frontmatter.deleted_at.is_some(),
        )?;
    }
    Ok(value)
}

pub(super) fn update_standalone_work_item_atomic_as<T, F>(
    org_id: &str,
    short_id: &str,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    service: AtomicServiceOptions,
    mutator: F,
) -> Result<(T, Vec<&'static str>, bool), String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    update_work_item_atomic_with_revisions_scoped(
        AtomicWorkItemScope::Standalone { org_id },
        short_id,
        HashMap::new(),
        actor,
        service,
        mutator,
    )
}

fn update_work_item_atomic_with_revisions_scoped<T, F>(
    scope: AtomicWorkItemScope<'_>,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
    service: AtomicServiceOptions,
    mutator: F,
) -> Result<(T, Vec<&'static str>, bool), String>
where
    F: FnOnce(&mut WorkItemFrontmatter, &mut String) -> Result<T, String>,
{
    let mut connection = conn()?;
    let tx = map_db(connection.transaction_with_behavior(TransactionBehavior::Immediate))?;

    let project_id = match scope {
        AtomicWorkItemScope::Project(project_slug) => Some(
            map_db(
                tx.query_row(
                    "SELECT id FROM projects WHERE slug = ?1",
                    params![project_slug],
                    |row| row.get(0),
                )
                .optional(),
            )?
            .ok_or_else(|| format!("Project '{}' not found", project_slug))?,
        ),
        AtomicWorkItemScope::Standalone { .. } => None,
    };

    let map_core = |row: &rusqlite::Row<'_>| {
        Ok(AtomicCore {
            work_item_id: row.get::<_, String>(0)?,
            short_id: row.get::<_, String>(1)?,
            title: row.get::<_, String>(2)?,
            body: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            status: row.get::<_, String>(4)?,
            priority: row.get::<_, String>(5)?,
            assignee: row.get::<_, Option<String>>(6)?,
            assignee_type: row.get::<_, Option<String>>(7)?,
            milestone: row.get::<_, Option<String>>(8)?,
            parent: row.get::<_, Option<String>>(9)?,
            start_date: row.get::<_, Option<String>>(10)?,
            target_date: row.get::<_, Option<String>>(11)?,
            created_at_ms: row.get::<_, i64>(12)?,
            updated_at_ms: row.get::<_, i64>(13)?,
            deleted_at_ms: row.get::<_, Option<i64>>(14)?,
            local_version: row.get::<_, i64>(15)?,
            org_id: row.get::<_, String>(16)?,
        })
    };
    let core = match scope {
        AtomicWorkItemScope::Project(_) => map_db(
            tx.query_row(
                "SELECT id, short_id, title, body, status, priority, assignee, assignee_type,
                        milestone, parent, start_date, target_date, created_at, updated_at,
                        deleted_at, local_version, org_id
                 FROM workitems
                 WHERE project_id = ?1 AND short_id = ?2",
                params![project_id.as_ref().expect("project scope id"), short_id],
                map_core,
            )
            .optional(),
        )?,
        AtomicWorkItemScope::Standalone { org_id } => map_db(
            tx.query_row(
                "SELECT id, short_id, title, body, status, priority, assignee, assignee_type,
                        milestone, parent, start_date, target_date, created_at, updated_at,
                        deleted_at, local_version, org_id
                 FROM workitems
                 WHERE org_id = ?1 AND project_id IS NULL AND short_id = ?2",
                params![org_id, short_id],
                map_core,
            )
            .optional(),
        )?,
    }
    .ok_or_else(|| format!("Work item '{}' not found", short_id))?;

    // OCC precondition (service callers only): the caller read revision N
    // and asked to mutate iff the row is still at N. Checked inside the
    // IMMEDIATE tx, so a concurrent writer either committed before us
    // (mismatch -> conflict) or queues behind us.
    if let Some(expected) = service.expected_local_version {
        if expected != core.local_version {
            return Err(format!(
                "{}:{}:{}",
                crate::work_service::error::REVISION_CONFLICT,
                expected,
                core.local_version
            ));
        }
    }

    // Read labels + extras inside the same tx so the snapshot is
    // strictly consistent with the row we just locked.
    let labels = read_labels_in_tx(&tx, &core.work_item_id)?;
    let extras_raw = map_db(
        tx.query_row(
            "SELECT extras_json FROM workitem_extras WHERE work_item_id = ?1",
            params![&core.work_item_id],
            |row| row.get::<_, String>(0),
        )
        .optional(),
    )?;
    // The atomic-mutate path reads extras → builds frontmatter →
    // mutates → serializes back. A silent default on a corrupt row
    // means the rebuilt frontmatter has no `field_revisions` /
    // `external_refs` / `orchestrator_state`, then the mutator's
    // serialized output overwrites the corrupt row — permanently
    // wiping the recoverable bytes. Warn so the corruption surfaces
    // before the next mutator destroys the row.
    let extras = match extras_raw.as_deref() {
        Some(json) => match serde_json::from_str::<ExtrasPayload>(json) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(
                    work_item_id = %core.work_item_id,
                    error = %err,
                    raw_len = json.len(),
                    "work_items::atomic: extras_json parse failed; this mutator will OVERWRITE the corrupt row with empty extras"
                );
                ExtrasPayload::default()
            }
        },
        None => ExtrasPayload::default(),
    };

    let mut frontmatter = build_frontmatter(project_id.clone(), &core, labels, &extras);
    let mut body = core.body.clone();

    // Snapshot every sync-tracked field's pre-mutation value so we can
    // diff after the mutator runs. Body is special-cased — it's stored
    // directly rather than on the frontmatter — so we capture it
    // alongside the frontmatter snapshot.
    let before = SyncFieldSnapshot::capture(&frontmatter, &body);
    let history_before = WorkItemHistorySnapshot::capture(&frontmatter, &body);
    let tail_before = payload_tail_fingerprint(&frontmatter);
    let scheduler_before = (
        frontmatter.status.clone(),
        frontmatter.start_date.clone(),
        frontmatter.schedule.clone(),
        frontmatter
            .orchestrator_config
            .as_ref()
            .and_then(|config| config.selected_account_id.clone()),
    );

    let result = mutator(&mut frontmatter, &mut body)?;

    // Portable-FSM validation on status changes (design §9.3). Strict
    // callers (the application service) get a hard reject; legacy paths
    // run flag-only so current UI flows keep working while the violation
    // is still visible in the audit stream.
    let status_changed = core.status != frontmatter.status;
    let mut fsm_violation: Option<String> = None;
    if status_changed {
        if let Err(violation) = crate::work_service::state::validate_legacy_transition(
            &core.status,
            &frontmatter.status,
        ) {
            if service.strict_fsm {
                return Err(crate::work_service::error::invalid_transition(
                    &core.status,
                    &frontmatter.status,
                ));
            }
            fsm_violation = Some(violation);
        }
    }

    let changed_fields = before.diff(&frontmatter, &body);
    let assignment_changed =
        core.assignee != frontmatter.assignee || core.assignee_type != frontmatter.assignee_type;
    let assigned_human_id = human_assignee_id(
        frontmatter.assignee.as_deref(),
        frontmatter.assignee_type.as_deref(),
    );
    let payload_tail_changed = payload_tail_fingerprint(&frontmatter) != tail_before;
    let scheduler_changed = scheduler_before
        != (
            frontmatter.status.clone(),
            frontmatter.start_date.clone(),
            frontmatter.schedule.clone(),
            frontmatter
                .orchestrator_config
                .as_ref()
                .and_then(|config| config.selected_account_id.clone()),
        );

    // Persist mutated state back. Always bump `local_version` so any
    // OCC observers (sync, future readers caching by version) detect it.
    let next_version = core.local_version.saturating_add(1);
    let now = now_ms();
    let created_at_ms = if frontmatter.created_at.is_empty() {
        core.created_at_ms
    } else {
        from_iso8601(&frontmatter.created_at)
    };
    let next_project_id = frontmatter.project.clone();
    let next_org_id: String = if let Some(next_project_id) = next_project_id.as_ref() {
        map_db(
            tx.query_row(
                "SELECT org_id FROM projects WHERE id = ?1",
                params![next_project_id],
                |row| row.get(0),
            )
            .optional(),
        )?
        .ok_or_else(|| format!("Project '{}' not found", next_project_id))?
    } else {
        core.org_id.clone()
    };
    if next_project_id != project_id {
        let exists_at_dest: bool = if let Some(next_project_id) = next_project_id.as_ref() {
            map_db(
                tx.query_row(
                    "SELECT 1 FROM workitems WHERE project_id = ?1 AND short_id = ?2 AND id <> ?3",
                    params![next_project_id, &core.short_id, &core.work_item_id],
                    |_| Ok(true),
                )
                .optional(),
            )?
            .unwrap_or(false)
        } else {
            map_db(
                tx.query_row(
                    "SELECT 1 FROM workitems WHERE org_id = ?1 AND project_id IS NULL AND short_id = ?2 AND id <> ?3",
                    params![&next_org_id, &core.short_id, &core.work_item_id],
                    |_| Ok(true),
                )
                .optional(),
            )?
            .unwrap_or(false)
        };
        if exists_at_dest {
            return Err(format!(
                "Work item '{}' already exists in destination scope",
                core.short_id
            ));
        }
    }

    map_db(tx.execute(
        "UPDATE workitems SET
            title         = ?1,
            body          = ?2,
            status        = ?3,
            priority      = ?4,
            assignee      = ?5,
            assignee_type = ?6,
            assigned_human_id = ?7,
            milestone     = ?8,
            parent        = ?9,
            start_date    = ?10,
            target_date   = ?11,
            org_id        = ?12,
            project_id    = ?13,
            created_at    = ?14,
            updated_at    = ?15,
            local_version = ?16,
            deleted_at    = ?18
         WHERE id = ?17",
        params![
            frontmatter.title,
            body,
            frontmatter.status,
            frontmatter.priority,
            frontmatter.assignee,
            frontmatter.assignee_type,
            assigned_human_id,
            frontmatter.milestone,
            frontmatter.parent,
            frontmatter.start_date,
            frontmatter.target_date,
            next_org_id,
            next_project_id,
            created_at_ms,
            now,
            next_version,
            &core.work_item_id,
            frontmatter
                .deleted_at
                .as_deref()
                .map(crate::projects::io::helpers::from_iso8601),
        ],
    ))?;

    if assignment_changed {
        // A receipt acknowledges one assignment episode, not the Work Item for
        // all time. Clear every viewer's old episode in the same transaction as
        // the assignee write so reassignment can never commit half-way.
        map_db(tx.execute(
            "DELETE FROM team_inbox_read_receipts
              WHERE source_kind = 'work_item_assigned' AND source_id = ?1",
            params![&core.work_item_id],
        ))?;
    }

    // Replace label set.
    map_db(tx.execute(
        "DELETE FROM workitem_labels WHERE work_item_id = ?1",
        params![&core.work_item_id],
    ))?;
    for label_id in &frontmatter.labels {
        map_db(tx.execute(
            "INSERT INTO workitem_labels (work_item_id, label_id) VALUES (?1, ?2)",
            params![&core.work_item_id, label_id],
        ))?;
    }

    // Reserialize extras. `from_frontmatter` rebuilds the user-visible
    // fields from the post-mutator frontmatter; we then layer the
    // sync-side metadata (field_revisions + external_refs) from the
    // pre-mutator extras snapshot back on top so the RMW doesn't
    // silently drop watermarks. Finally, stamp:
    //
    // - Every sync-tracked field that actually changed (per the diff)
    //   with `("local", now)` — unless the same field is in
    //   `override_revisions`, in which case the override wins.
    // - Every field present in `override_revisions` with the supplied
    //   revision, regardless of whether the value diffed. This is
    //   what lets the merge cycle pin watermarks for fields where the
    //   resolver-adopted value happens to equal the pre-mutator value.
    append_mutation_event(
        &history_before,
        &mut frontmatter,
        &body,
        &to_iso8601(now),
        actor,
    );

    let mut next_extras = ExtrasPayload::from_frontmatter(&frontmatter);
    next_extras.field_revisions = extras.field_revisions.clone();
    next_extras.external_refs = extras.external_refs.clone();
    for field in &changed_fields {
        if override_revisions.contains_key(*field) {
            continue;
        }
        next_extras.field_revisions.insert(
            (*field).to_string(),
            FieldRevision {
                mtime: now,
                source: REVISION_SOURCE_LOCAL.to_string(),
            },
        );
    }
    for (field, revision) in &override_revisions {
        next_extras
            .field_revisions
            .insert(field.clone(), revision.clone());
    }
    let next_extras_json =
        serde_json::to_string(&next_extras).map_err(|err| format!("serialize extras: {}", err))?;
    map_db(tx.execute(
        "INSERT INTO workitem_extras (work_item_id, extras_json)
         VALUES (?1, ?2)
         ON CONFLICT(work_item_id) DO UPDATE SET extras_json = excluded.extras_json",
        params![&core.work_item_id, next_extras_json],
    ))?;

    // Audit + cross-process watermark, same transaction as the mutation
    // (frozen persistence invariant, design §19). Every RMW path funnels
    // through here, so UI patches, agent tools, sync merges and the
    // future CLI are all audited without per-caller wiring.
    let seq = crate::work_service::audit::bump_change_seq(&tx)?;
    let mut audit_payload = serde_json::json!({
        "changed_fields": changed_fields,
    });
    if status_changed {
        audit_payload["status_from"] = serde_json::Value::String(core.status.clone());
        audit_payload["status_to"] = serde_json::Value::String(frontmatter.status.clone());
    }
    if let Some(violation) = &fsm_violation {
        audit_payload["fsm_violation"] = serde_json::Value::String(violation.clone());
    }
    if let Some(reason) = &service.reason {
        audit_payload["reason"] = serde_json::Value::String(reason.clone());
    }
    crate::work_service::audit::append_audit_event(
        &tx,
        &crate::work_service::audit::AuditEventRow {
            operation: service.operation.unwrap_or("work.patch"),
            entity_type: "work_item",
            entity_id: &core.work_item_id,
            project_slug: match scope {
                AtomicWorkItemScope::Project(slug) => Some(slug),
                AtomicWorkItemScope::Standalone { .. } => None,
            },
            org_id: Some(&next_org_id),
            actor,
            revision: next_version,
            seq,
            payload: audit_payload,
        },
    )?;

    map_db(tx.commit())?;
    if scheduler_changed {
        crate::projects::events::notify_work_item_schedule_changed();
    }
    if status_changed {
        use crate::work_service::state::{map_legacy_status, WorkItemState};
        let was_terminal = matches!(
            map_legacy_status(&core.status),
            Some(WorkItemState::Completed | WorkItemState::Failed | WorkItemState::Cancelled)
        );
        let is_terminal = matches!(
            map_legacy_status(&frontmatter.status),
            Some(WorkItemState::Completed | WorkItemState::Failed | WorkItemState::Cancelled)
        );
        if is_terminal && !was_terminal {
            crate::projects::events::notify_work_item_terminal(
                crate::projects::events::WorkItemTerminalEvent {
                    org_id: next_org_id.clone(),
                    project_slug: match scope {
                        AtomicWorkItemScope::Project(slug) => Some(slug.to_string()),
                        AtomicWorkItemScope::Standalone { .. } => None,
                    },
                    short_id: core.short_id.clone(),
                    parent: frontmatter.parent.clone(),
                    status: frontmatter.status.clone(),
                },
            );
        }
    }
    Ok((result, changed_fields, payload_tail_changed))
}

/// Serialized snapshot of every field that rides only in the collab
/// server's payload jsonb (design §16.3) — i.e. outside the
/// sync-tracked hot-field set — used to detect tail-only mutations in
/// the closure-form atomic path. `history` is deliberately excluded:
/// the history append accompanies every real change (and would make
/// no-op mutators look like changes once `append_mutation_event`
/// fires for the accompanying field).
fn payload_tail_fingerprint(fm: &WorkItemFrontmatter) -> serde_json::Value {
    serde_json::json!({
        "project": fm.project,
        "parent": fm.parent,
        "stage": fm.stage,
        "assignee_type": fm.assignee_type,
        "starred": fm.starred,
        "created_by": fm.created_by,
        "origin_session": fm.origin_session,
        "todos": fm.todos,
        "comments": fm.comments,
        "handoff": fm.handoff,
        "linked_sessions": fm.linked_sessions,
        "proof_of_work": fm.proof_of_work,
        "orchestrator_config": fm.orchestrator_config,
        "orchestrator_state": fm.orchestrator_state,
        "schedule": fm.schedule,
        "execution_lock": fm.execution_lock,
        "close_out": fm.close_out,
        "work_products": fm.work_products,
    })
}

/// Apply a partial update and return the new `WorkItemData`.
///
/// Outbox emission: when the project is bound to a sync adapter,
/// every successful update appends one `update` outbox row carrying
/// the changed sync-tracked fields and their new values.
/// The merge cycle bypasses this (it calls
/// [`update_work_item_partial_with_revisions`] directly) so applying a
/// remote-driven change doesn't bounce back to the originating system
/// as a push.
pub fn update_work_item_partial(
    project_slug: &str,
    short_id: &str,
    updates: &WorkItemPartialUpdate,
) -> Result<WorkItemData, String> {
    let (data, changed_fields) =
        update_work_item_partial_with_revisions(project_slug, short_id, HashMap::new(), updates)?;
    if !changed_fields.is_empty() {
        let payload = changed_fields_payload(&data, &changed_fields);
        crate::sync::io::record_local_update(project_slug, short_id, &changed_fields, &payload)?;
    } else if touches_payload_tail(updates) {
        // Payload-tail-only patch (todos / comments / linked sessions /
        // orchestrator state / lock …): not covered by the sync-tracked
        // diff, but collab-synced orgs still need to push the row —
        // those fields travel in the server payload jsonb (design §16.3).
        crate::sync::collab_bridge::record_work_item_payload_touch(project_slug, short_id)?;
    }
    Ok(data)
}

/// Standalone-org counterpart to [`update_work_item_partial`].
///
/// The mutation shares the same `BEGIN IMMEDIATE` boundary, history writer,
/// assignment-receipt reset, and field-revision logic as project-scoped work
/// items. A single collaboration outbox write is emitted after commit so
/// teammates receive status, priority, assignment, todo, and comment changes
/// without a frontend read-modify-write race.
pub fn update_standalone_work_item_partial(
    org_id: Option<&str>,
    short_id: &str,
    updates: &WorkItemPartialUpdate,
) -> Result<WorkItemData, String> {
    let org_id = org_id.unwrap_or("personal-org");
    let (data, changed_fields, payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Standalone { org_id },
        short_id,
        HashMap::new(),
        updates,
    )?;
    if !changed_fields.is_empty() || payload_tail_changed {
        crate::sync::collab_bridge::record_work_item_write(
            org_id,
            None,
            &data.frontmatter.id,
            data.frontmatter.deleted_at.is_some(),
        )?;
    }
    Ok(data)
}

/// True when the patch touches any field that lives only in the server
/// payload jsonb (outside the sync-tracked field set).
fn touches_payload_tail(updates: &WorkItemPartialUpdate) -> bool {
    updates.todos.is_some()
        || updates.comments.is_some()
        || updates.handoff.is_some()
        || updates.linked_sessions.is_some()
        || updates.orchestrator_config.is_some()
        || updates.orchestrator_state.is_some()
        || updates.schedule.is_some()
        || updates.execution_lock.is_some()
        || updates.close_out.is_some()
        || updates.work_products.is_some()
        || updates.starred.is_some()
        || updates.assignee_type.is_some()
        || updates.project.is_some()
        || updates.created_by.is_some()
        || updates.stage.is_some()
}

/// Build the JSON payload that gets persisted to
/// `outbox_entries.payload_json` for an `update` row. Includes every
/// changed sync-tracked field's post-mutation value so the adapter
/// doesn't have to round-trip the work item to push.
fn changed_fields_payload(
    data: &WorkItemData,
    changed_fields: &[&'static str],
) -> serde_json::Value {
    let mut object = serde_json::Map::new();
    for field in changed_fields {
        let value = match *field {
            "title" => serde_json::Value::String(data.frontmatter.title.clone()),
            "body" => serde_json::Value::String(data.body.clone()),
            "status" => serde_json::Value::String(data.frontmatter.status.clone()),
            "priority" => serde_json::Value::String(data.frontmatter.priority.clone()),
            "assignee" => match data.frontmatter.assignee.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "milestone" => match data.frontmatter.milestone.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "start_date" => match data.frontmatter.start_date.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "target_date" => match data.frontmatter.target_date.as_ref() {
                Some(value) => serde_json::Value::String(value.clone()),
                None => serde_json::Value::Null,
            },
            "labels" => serde_json::Value::Array(
                data.frontmatter
                    .labels
                    .iter()
                    .map(|label| serde_json::Value::String(label.clone()))
                    .collect(),
            ),
            // Defensive — if a future field name lands in `changed_fields`
            // before the payload helper learns it, drop the field from
            // the payload rather than crash. The outbox row will still
            // record it via `field_path`.
            _ => continue,
        };
        object.insert((*field).to_string(), value);
    }
    serde_json::Value::Object(object)
}

/// Variant of [`update_work_item_partial`] that lets the caller supply
/// per-field revision overrides and returns the list of changed
/// sync-tracked fields alongside the updated data.
///
/// User-driven callsites should use [`update_work_item_partial`]; the
/// merge cycle uses this directly, passing
/// `ResolverDecision::new_revisions` so adopted fields are stamped
/// atomically with the field write.
pub fn update_work_item_partial_with_revisions(
    project_slug: &str,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>), String> {
    let (data, changed_fields, _payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Project(project_slug),
        short_id,
        override_revisions,
        updates,
    )?;
    Ok((data, changed_fields))
}

/// Standalone-org merge-cycle counterpart to
/// [`update_work_item_partial_with_revisions`].
///
/// This intentionally emits no outbox row: the caller is applying an inbound
/// remote snapshot and must not echo it back to the collaboration service.
pub(crate) fn update_standalone_work_item_partial_with_revisions(
    org_id: &str,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>), String> {
    let (data, changed_fields, _payload_tail_changed) = update_work_item_partial_scoped(
        AtomicWorkItemScope::Standalone { org_id },
        short_id,
        override_revisions,
        updates,
    )?;
    Ok((data, changed_fields))
}

fn update_work_item_partial_scoped(
    scope: AtomicWorkItemScope<'_>,
    short_id: &str,
    override_revisions: HashMap<String, FieldRevision>,
    updates: &WorkItemPartialUpdate,
) -> Result<(WorkItemData, Vec<&'static str>, bool), String> {
    update_work_item_atomic_with_revisions_scoped(
        scope,
        short_id,
        override_revisions,
        updates.actor.as_ref(),
        AtomicServiceOptions::default(),
        |fm, body| {
            let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

            if let Some(title) = updates.title.as_ref() {
                fm.title = title.clone();
            }
            if let Some(new_body) = updates.body.as_ref() {
                *body = new_body.clone();
            }
            if let Some(status) = updates.status.as_ref() {
                fm.status = status.clone();
            }
            if let Some(priority) = updates.priority.as_ref() {
                fm.priority = priority.clone();
            }
            if let Some(project) = updates.project.as_ref() {
                fm.project = project.clone();
            }
            if let Some(starred) = updates.starred {
                fm.starred = starred;
            }
            if let Some(assignee) = updates.assignee.as_ref() {
                fm.assignee = assignee.clone();
            }
            if let Some(assignee_type) = updates.assignee_type.as_ref() {
                fm.assignee_type = assignee_type.clone();
            }
            if let Some(labels) = updates.labels.as_ref() {
                fm.labels = labels.clone();
            }
            if let Some(milestone) = updates.milestone.as_ref() {
                fm.milestone = milestone.clone();
            }
            if let Some(stage) = updates.stage.as_ref() {
                fm.stage = *stage;
            }
            if let Some(start_date) = updates.start_date.as_ref() {
                fm.start_date = start_date.clone();
            }
            if let Some(target_date) = updates.target_date.as_ref() {
                fm.target_date = target_date.clone();
            }
            if let Some(created_by) = updates.created_by.as_ref() {
                fm.created_by = Some(created_by.clone());
            }
            if let Some(todos) = updates.todos.as_ref() {
                fm.todos = todos.clone();
            }
            if let Some(comments) = updates.comments.as_ref() {
                fm.comments = comments.clone();
            }
            if let Some(handoff) = updates.handoff.as_ref() {
                fm.handoff = handoff.clone();
            }
            if let Some(linked_sessions) = updates.linked_sessions.as_ref() {
                fm.linked_sessions = linked_sessions.clone();
            }
            if let Some(orchestrator_config) = updates.orchestrator_config.as_ref() {
                fm.orchestrator_config = Some(orchestrator_config.clone());
            }
            if let Some(orchestrator_state) = updates.orchestrator_state.as_ref() {
                fm.orchestrator_state = Some(orchestrator_state.clone());
            }
            if let Some(schedule) = updates.schedule.as_ref() {
                fm.schedule = schedule.clone();
            }
            if let Some(execution_lock) = updates.execution_lock.as_ref() {
                fm.execution_lock = execution_lock.clone();
            }
            if let Some(close_out) = updates.close_out.as_ref() {
                fm.close_out = close_out.clone();
            }
            if let Some(work_products) = updates.work_products.as_ref() {
                fm.work_products = work_products.clone();
            }

            fm.updated_at = now_iso;

            Ok(WorkItemData {
                frontmatter: fm.clone(),
                body: body.clone(),
                filename: short_id.to_string(),
            })
        },
    )
}

// ---------------------------------------------------------------------
// Internal helpers (kept private to this file)
// ---------------------------------------------------------------------

/// Snapshot of every sync-tracked field's value before the mutator
/// runs. Used to compute the changed-fields list once the mutator
/// returns. We clone the values rather than holding references because
/// the frontmatter is itself mutated in place, and we want a stable
/// "before" view to diff against.
struct SyncFieldSnapshot {
    title: String,
    body: String,
    status: String,
    priority: String,
    assignee: Option<String>,
    milestone: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    labels: Vec<String>,
}

impl SyncFieldSnapshot {
    fn capture(fm: &WorkItemFrontmatter, body: &str) -> Self {
        Self {
            title: fm.title.clone(),
            body: body.to_string(),
            status: fm.status.clone(),
            priority: fm.priority.clone(),
            assignee: fm.assignee.clone(),
            milestone: fm.milestone.clone(),
            start_date: fm.start_date.clone(),
            target_date: fm.target_date.clone(),
            labels: fm.labels.clone(),
        }
    }

    /// Returns the canonical names of every sync-tracked field whose
    /// post-mutation value differs from the captured value. Order
    /// matches [`SYNC_TRACKED_FIELDS`] so callers see a stable
    /// iteration sequence (useful in tests and outbox payload logs).
    fn diff(&self, fm: &WorkItemFrontmatter, body: &str) -> Vec<&'static str> {
        let mut changed = Vec::new();
        if self.title != fm.title {
            changed.push("title");
        }
        if self.body != body {
            changed.push("body");
        }
        if self.status != fm.status {
            changed.push("status");
        }
        if self.priority != fm.priority {
            changed.push("priority");
        }
        if self.assignee != fm.assignee {
            changed.push("assignee");
        }
        if self.milestone != fm.milestone {
            changed.push("milestone");
        }
        if self.start_date != fm.start_date {
            changed.push("start_date");
        }
        if self.target_date != fm.target_date {
            changed.push("target_date");
        }
        if !slices_equal_unordered(&self.labels, &fm.labels) {
            changed.push("labels");
        }
        changed
    }
}

/// Compare two label slices ignoring order. Labels are persisted as a
/// set in `workitem_labels`, so a permutation isn't a real change.
fn slices_equal_unordered(left: &[String], right: &[String]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut left_sorted = left.to_vec();
    let mut right_sorted = right.to_vec();
    left_sorted.sort();
    right_sorted.sort();
    left_sorted == right_sorted
}

fn human_assignee_id(assignee: Option<&str>, assignee_type: Option<&str>) -> Option<String> {
    let assignee = assignee?.trim();
    if assignee.is_empty() {
        return None;
    }
    let is_human = assignee_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.eq_ignore_ascii_case("member") || value.eq_ignore_ascii_case("human"))
        .unwrap_or(true);
    is_human.then(|| assignee.to_string())
}

struct AtomicCore {
    work_item_id: String,
    short_id: String,
    title: String,
    body: String,
    status: String,
    priority: String,
    assignee: Option<String>,
    assignee_type: Option<String>,
    milestone: Option<String>,
    parent: Option<String>,
    start_date: Option<String>,
    target_date: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    deleted_at_ms: Option<i64>,
    local_version: i64,
    org_id: String,
}

fn read_labels_in_tx(
    tx: &rusqlite::Transaction<'_>,
    work_item_id: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = map_db(tx.prepare(
        "SELECT label_id FROM workitem_labels WHERE work_item_id = ?1 ORDER BY label_id",
    ))?;
    let rows = map_db(stmt.query_map(params![work_item_id], |row| row.get::<_, String>(0)))?;
    let mut out = Vec::new();
    for entry in rows {
        out.push(map_db(entry)?);
    }
    Ok(out)
}

fn build_frontmatter(
    project_id: Option<String>,
    core: &AtomicCore,
    labels: Vec<String>,
    extras: &ExtrasPayload,
) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: core.work_item_id.clone(),
        short_id: core.short_id.clone(),
        title: core.title.clone(),
        project: project_id,
        status: core.status.clone(),
        priority: core.priority.clone(),
        assignee: core.assignee.clone(),
        assignee_type: core.assignee_type.clone(),
        labels,
        milestone: core.milestone.clone(),
        parent: core.parent.clone(),
        stage: extras.stage,
        start_date: core.start_date.clone(),
        target_date: core.target_date.clone(),
        created_by: extras.created_by.clone(),
        origin_session: extras.origin_session.clone(),
        created_at: to_iso8601(core.created_at_ms),
        updated_at: to_iso8601(core.updated_at_ms),
        deleted_at: core.deleted_at_ms.map(to_iso8601),
        starred: extras.starred,
        todos: extras.todos.clone(),
        comments: extras.comments.clone(),
        history: extras.history.clone(),
        delegations: extras.delegations.clone(),
        handoff: extras.handoff.clone(),
        linked_sessions: extras.linked_sessions.clone(),
        proof_of_work: extras.proof_of_work.clone(),
        orchestrator_config: extras.orchestrator_config.clone(),
        orchestrator_state: extras.orchestrator_state.clone(),
        follow_up_items: extras.follow_up_items.clone(),
        schedule: extras.schedule.clone(),
        routine_source: extras.routine_source.clone(),
        execution_lock: extras.execution_lock.clone(),
        close_out: extras.close_out.clone(),
        work_products: extras.work_products.clone(),
    }
}

#[cfg(test)]
#[path = "atomic_tests.rs"]
mod tests;
