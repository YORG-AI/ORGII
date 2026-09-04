//! The single `BEGIN IMMEDIATE` read-modify-write transaction every
//! atomic work-item path funnels through: row lock, OCC precondition,
//! mutator, FSM check, row/label/extras write-back, audit + watermark,
//! commit, post-commit notifications.

use std::collections::HashMap;

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use super::diff::{payload_tail_fingerprint, SyncFieldSnapshot};
use super::row::{build_frontmatter, human_assignee_id, read_labels_in_tx, AtomicCore};
use super::scope::{AtomicServiceOptions, AtomicWorkItemScope};
use crate::projects::io::helpers::{conn, from_iso8601, map_db, now_ms, to_iso8601};
use crate::projects::io::work_items::extras::{ExtrasPayload, FieldRevision, REVISION_SOURCE_LOCAL};
use crate::projects::io::work_items::history::{append_mutation_event, WorkItemHistorySnapshot};
use crate::projects::types::WorkItemFrontmatter;

pub(super) fn update_work_item_atomic_with_revisions_scoped<T, F>(
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
