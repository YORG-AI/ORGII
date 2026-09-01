//! Closure-form public entry points: project-scoped and standalone
//! atomic RMW wrappers around the engine, plus their post-commit
//! outbox / collab-bridge emission.

use std::collections::HashMap;

use super::diff::changed_fields_payload;
use super::engine::update_work_item_atomic_with_revisions_scoped;
use super::scope::{AtomicServiceOptions, AtomicWorkItemScope};
use crate::projects::io::work_items::extras::FieldRevision;
use crate::projects::types::WorkItemFrontmatter;

// Referenced by intra-doc links below; not called from this module.
#[allow(unused_imports)]
use super::diff::{payload_tail_fingerprint, SYNC_TRACKED_FIELDS};
#[allow(unused_imports)]
use super::partial::update_work_item_partial;

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
        let data = super::super::crud::read_work_item(project_slug, short_id)?;
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
        let data = super::super::crud::read_work_item(project_slug, short_id)?;
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
        let data = super::super::crud::read_standalone_work_item(Some(org_id), short_id)?;
        crate::sync::collab_bridge::record_work_item_write(
            org_id,
            None,
            &data.frontmatter.id,
            data.frontmatter.deleted_at.is_some(),
        )?;
    }
    Ok(value)
}

pub(in crate::projects::io::work_items) fn update_standalone_work_item_atomic_as<T, F>(
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
