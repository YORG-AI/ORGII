//! Field-level conflict resolver.
//!
//! Pure functions consumed by [`super::worker::merge_cycle`]. Given an
//! [`ExternalChange`] (one inbound row from a `merge_external` outbox
//! entry), the local item's [`SyncMetadata`] (per-field watermarks +
//! external-id map), and the adapter's declarative [`FieldMap`], the
//! resolver decides per writable field whether to:
//!
//! - **adopt remote** — the inbound value overwrites local; stamp a new
//!   `(remote_updated_at, adapter_id)` revision;
//! - **keep local** — local has a newer revision than the inbound
//!   change; do nothing;
//! - **delegate** — equal mtimes (or no local revision recorded) fall
//!   through to the adapter's `handle_conflict` policy.
//!
//! No I/O happens here. The merge cycle reads
//! [`ResolverDecision::adopted_fields`] into a
//! [`WorkItemPartialUpdate`] and reads
//! [`ResolverDecision::new_revisions`] into the
//! [`super::super::projects::io::work_items::apply_remote_merge`] call
//! — both inside the worker's blocking pool guard.
//!
//! # Why split decision from application?
//!
//! Two reasons:
//! 1. **Testability.** Every branch is a pure-data assertion; the test
//!    suite never touches the DB or the network.
//! 2. **Atomicity.** The merge cycle wants both the partial update and
//!    the revision stamp to land in one tx; building the decision
//!    up-front means the I/O step is a straight-line write rather than
//!    a chain of conditional reads.
//!
//! Per the plan, only fields the adapter declares `writable = true` are
//! candidates. Read-only mappings (e.g. GitHub assignee names without
//! user-id resolution) are skipped here so we don't accidentally write
//! a value back through the partial-update path.

use std::collections::HashMap;

use serde_json::Value;

use super::adapter::{ConflictResolution, EntityField, ExternalChange, FieldMap, SyncAdapter};
use crate::projects::io::{FieldRevision, SyncMetadata};

/// Verdict produced by the resolver. The merge cycle reads this struct
/// and emits the corresponding writes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResolverDecision {
    /// Local field name → adopted value. The merge cycle translates
    /// these into a [`crate::projects::types::WorkItemPartialUpdate`].
    pub adopted_fields: HashMap<String, Value>,
    /// Local field name → new revision watermark for adopted fields.
    /// Stamped via [`super::super::projects::io::work_items::apply_remote_merge`].
    pub new_revisions: HashMap<String, FieldRevision>,
    /// Local field names where the resolver kept the local value.
    /// Carried for observability — the merge cycle logs them at debug
    /// level so we can audit "why didn't this remote change land?".
    pub kept_local: Vec<String>,
    /// True when the inbound change is a tombstone (`deleted = true`).
    /// The merge cycle handles this separately from field merges
    /// because deletion is a whole-entity verb.
    pub is_delete: bool,
}

/// Run the resolver against one inbound change.
///
/// `adapter` is borrowed solely for its `name()` (used as the new
/// revision source) and its `handle_conflict()` callback for ties.
/// Async-trait methods aren't called here — the only adapter method
/// the resolver could invoke (`handle_conflict`) is consulted by
/// [`resolve_with_policy`] under the hood, which the merge cycle
/// uses directly when it needs to await.
///
/// This synchronous overload uses [`ConflictResolution::UseRemote`] as
/// the tie-break, mirroring the trait default. Tests can call
/// [`resolve_with_policy`] to exercise alternative policies without
/// constructing a full [`SyncAdapter`].
pub fn resolve(
    change: &ExternalChange,
    metadata: &SyncMetadata,
    adapter: &dyn SyncAdapter,
) -> ResolverDecision {
    resolve_with_policy(
        change,
        metadata,
        adapter.name(),
        adapter.entity_field_map(),
        None,
        |_| ConflictResolution::UseRemote,
    )
}

/// Resolver with an explicit tie-break policy. Used by tests and by
/// the merge cycle when it wants to fan out
/// [`SyncAdapter::handle_conflict`] async calls before deciding.
///
/// `tie_break` is invoked once per field where the local watermark and
/// the inbound `remote_updated_at` are equal-or-undecided. The default
/// policy (`UseRemote`) matches [`SyncAdapter`]'s trait default.
pub fn resolve_with_policy<F>(
    change: &ExternalChange,
    metadata: &SyncMetadata,
    adapter_id: &str,
    field_map: &FieldMap,
    // Optional per-field remote mtimes (local field name → mtime ms). When
    // `Some`, each field is compared against its OWN remote mtime and a field
    // absent from the map is treated as "the remote author did not touch it"
    // (keep local) — correct when `change.fields` is a whole-row snapshot whose
    // untouched fields still carry stale values. `None` keeps the legacy
    // whole-row `remote_updated_at` clock (Linear/GitHub emit only changed
    // fields, so a stale carry-over never appears).
    remote_field_mtimes: Option<&HashMap<String, i64>>,
    mut tie_break: F,
) -> ResolverDecision
where
    F: FnMut(&str) -> ConflictResolution,
{
    let mut decision = ResolverDecision {
        is_delete: change.deleted,
        ..ResolverDecision::default()
    };

    if change.deleted {
        // Don't bother walking the field map for tombstones. The merge
        // cycle interprets `is_delete` as "skip the partial update,
        // run delete_work_item, stamp every-field revision tombstone."
        return decision;
    }

    let remote_mtime_ms = change.remote_updated_at.timestamp_millis();
    let remote_obj = match change.fields.as_object() {
        Some(obj) => obj,
        // Empty / non-object payload with deleted=false is a malformed
        // change; treat as no-op so the merge cycle marks it succeeded
        // and moves on. The adapter that produced this is responsible
        // for not emitting it again next pull.
        None => return decision,
    };

    for mapping in field_map.mappings.iter() {
        if !mapping.writable {
            continue;
        }
        let local_name = local_field_name(mapping.local);
        let Some(remote_value) = remote_obj.get(local_name) else {
            // The adapter declared the mapping but the inbound row
            // doesn't carry that field this cycle. Nothing to merge.
            continue;
        };

        // Per-field remote mtime when the adapter supplies one. If the map is
        // present but this field is absent, the remote author did NOT change
        // it (the wire value is a stale whole-row carry-over) — keep local.
        let field_mtime_ms = match remote_field_mtimes {
            Some(map) => match map.get(local_name) {
                Some(mtime) => *mtime,
                None => {
                    decision.kept_local.push(local_name.to_string());
                    continue;
                }
            },
            None => remote_mtime_ms,
        };

        match decide_one(
            local_name,
            field_mtime_ms,
            &metadata.field_revisions,
            &mut tie_break,
        ) {
            Verdict::AdoptRemote => {
                decision
                    .adopted_fields
                    .insert(local_name.to_string(), remote_value.clone());
                decision.new_revisions.insert(
                    local_name.to_string(),
                    FieldRevision {
                        // Stamp the adopted field with ITS remote mtime so a
                        // re-pull is idempotent and later comparisons are
                        // per-field accurate.
                        mtime: field_mtime_ms,
                        source: adapter_id.to_string(),
                    },
                );
            }
            Verdict::KeepLocal => {
                decision.kept_local.push(local_name.to_string());
            }
        }
    }

    decision
}

/// Named-field variant of [`resolve_with_policy`] for entities that are
/// not adapter entities — projects, whose field set (`name`, `health`,
/// `lead`, `description`, `work_item_prefix`, …) has no
/// [`EntityField`](super::adapter::EntityField) variants and therefore
/// no [`FieldMap`]. Same per-field policy:
///
/// - `remote_field_mtimes = Some(map)`: each field present in `fields`
///   is compared against its OWN remote mtime; a field absent from the
///   map is a stale whole-row carry-over the remote author didn't touch
///   — keep local.
/// - `remote_field_mtimes = None`: legacy whole-row clock
///   (`remote_row_mtime_ms` for every field).
///
/// `revisions` is the entity's local per-field watermark store (for
/// projects, `projects.field_revisions_json`). Ties adopt remote,
/// matching the collab bridge's fixed `UseRemote` policy.
pub fn resolve_named_fields(
    field_names: &[&str],
    fields: &Value,
    remote_row_mtime_ms: i64,
    revisions: &HashMap<String, FieldRevision>,
    revision_source: &str,
    remote_field_mtimes: Option<&HashMap<String, i64>>,
) -> ResolverDecision {
    let mut decision = ResolverDecision::default();
    let Some(remote_obj) = fields.as_object() else {
        return decision;
    };
    let mut tie_break = |_: &str| ConflictResolution::UseRemote;
    for &local_name in field_names {
        let Some(remote_value) = remote_obj.get(local_name) else {
            continue;
        };
        let field_mtime_ms = match remote_field_mtimes {
            Some(map) => match map.get(local_name) {
                Some(mtime) => *mtime,
                None => {
                    decision.kept_local.push(local_name.to_string());
                    continue;
                }
            },
            None => remote_row_mtime_ms,
        };
        match decide_one(local_name, field_mtime_ms, revisions, &mut tie_break) {
            Verdict::AdoptRemote => {
                decision
                    .adopted_fields
                    .insert(local_name.to_string(), remote_value.clone());
                decision.new_revisions.insert(
                    local_name.to_string(),
                    FieldRevision {
                        mtime: field_mtime_ms,
                        source: revision_source.to_string(),
                    },
                );
            }
            Verdict::KeepLocal => {
                decision.kept_local.push(local_name.to_string());
            }
        }
    }
    decision
}

enum Verdict {
    AdoptRemote,
    KeepLocal,
}

/// Per-field decision logic. Extracted so the same policy applies to
/// every field without re-stating the comparison.
fn decide_one(
    local_name: &str,
    remote_mtime_ms: i64,
    revisions: &HashMap<String, FieldRevision>,
    tie_break: &mut dyn FnMut(&str) -> ConflictResolution,
) -> Verdict {
    match revisions.get(local_name) {
        // No local watermark = field has never been touched locally
        // (or by a previous sync). Take the remote value — that's
        // the natural "first sight wins" policy and matches what
        // happens on initial project attach.
        None => Verdict::AdoptRemote,
        Some(rev) => {
            if rev.mtime < remote_mtime_ms {
                Verdict::AdoptRemote
            } else if rev.mtime > remote_mtime_ms {
                Verdict::KeepLocal
            } else {
                // Equal mtimes are rare in practice but happen when
                // both sides write inside the same millisecond
                // (e.g. burst test runs). Defer to the adapter's
                // `handle_conflict` for the tiebreak.
                match tie_break(local_name) {
                    ConflictResolution::UseRemote => Verdict::AdoptRemote,
                    ConflictResolution::KeepLocal => Verdict::KeepLocal,
                    // `Merge` is a placeholder for adapters that want
                    // a custom union; without one we fall back to the
                    // safer "use remote" — the resolver shouldn't
                    // synthesize merged values without an adapter
                    // hook to author them.
                    ConflictResolution::Merge => Verdict::AdoptRemote,
                }
            }
        }
    }
}

fn local_field_name(field: EntityField) -> &'static str {
    field.as_local_name()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::adapter::{
        AdapterDescriptor, EntityField, FieldMap, FieldMapping, PullOutcome, SyncContext,
    };
    use crate::sync::types::{EntityType, OutboxEntry, SyncError, SyncResult};
    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone, Utc};
    use serde_json::json;

    /// Tiny stand-in adapter so we can build a `&dyn SyncAdapter`
    /// without dragging the real Linear/GitHub clients into resolver
    /// unit tests.
    #[derive(Debug, Default)]
    struct StubAdapter;

    static STUB_FIELD_MAP: FieldMap = FieldMap {
        mappings: &[
            FieldMapping {
                local: EntityField::Title,
                remote: "title",
                writable: true,
            },
            FieldMapping {
                local: EntityField::Status,
                remote: "state",
                writable: true,
            },
            FieldMapping {
                local: EntityField::Body,
                remote: "body",
                writable: true,
            },
            FieldMapping {
                local: EntityField::Assignee,
                // Read-only — resolver should never write this even if
                // the inbound payload includes it.
                remote: "assignee",
                writable: false,
            },
        ],
    };

    #[async_trait]
    impl SyncAdapter for StubAdapter {
        fn name(&self) -> &'static str {
            "stub"
        }
        async fn push(&self, _entry: &OutboxEntry, _ctx: &SyncContext) -> SyncResult {
            Err(SyncError::Permanent("stub does not push".to_string()))
        }
        async fn pull(
            &self,
            _slug: &str,
            _ctx: &SyncContext,
            _since: Option<DateTime<Utc>>,
        ) -> Result<PullOutcome, SyncError> {
            Ok(PullOutcome::default())
        }
        fn entity_field_map(&self) -> &'static FieldMap {
            &STUB_FIELD_MAP
        }
        fn descriptor(&self) -> AdapterDescriptor {
            AdapterDescriptor {
                id: "stub".to_string(),
                label: "Stub".to_string(),
                requires_auth: false,
                auth_methods: Vec::new(),
                supports_webhook: false,
                supports_import: false,
            }
        }
    }

    fn change(updated_at: DateTime<Utc>, fields: Value, deleted: bool) -> ExternalChange {
        ExternalChange {
            entity_type: EntityType::WorkItem,
            external_id: "ext-1".to_string(),
            local_entity_id: None,
            fields,
            remote_updated_at: updated_at,
            deleted,
        }
    }

    fn metadata_with(revisions: &[(&str, i64, &str)]) -> SyncMetadata {
        let mut m = SyncMetadata::default();
        for (name, mtime, source) in revisions {
            m.field_revisions.insert(
                name.to_string(),
                FieldRevision {
                    mtime: *mtime,
                    source: source.to_string(),
                },
            );
        }
        m
    }

    #[test]
    fn never_seen_field_adopts_remote() {
        let metadata = SyncMetadata::default();
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "Remote title" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert_eq!(decision.adopted_fields["title"], "Remote title");
        assert_eq!(decision.new_revisions["title"].mtime, 1_700_000_000_000);
        assert_eq!(decision.new_revisions["title"].source, "stub");
        assert!(decision.kept_local.is_empty());
        assert!(!decision.is_delete);
    }

    #[test]
    fn newer_local_revision_keeps_local() {
        let metadata = metadata_with(&[("title", 2_000_000_000_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "Stale remote" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert!(decision.adopted_fields.is_empty());
        assert_eq!(decision.kept_local, vec!["title".to_string()]);
    }

    #[test]
    fn older_local_revision_adopts_remote() {
        let metadata = metadata_with(&[("title", 1_500_000_000_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "Fresher remote" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert_eq!(decision.adopted_fields["title"], "Fresher remote");
        assert_eq!(decision.new_revisions["title"].mtime, 1_700_000_000_000);
    }

    #[test]
    fn equal_mtime_ties_break_via_use_remote_default() {
        let metadata = metadata_with(&[("title", 1_700_000_000_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "Tied remote" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert_eq!(decision.adopted_fields["title"], "Tied remote");
    }

    #[test]
    fn equal_mtime_with_keep_local_policy_keeps_local() {
        let metadata = metadata_with(&[("title", 1_700_000_000_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "Tied remote" }),
            false,
        );
        let decision =
            resolve_with_policy(&inbound, &metadata, "stub", &STUB_FIELD_MAP, None, |_| {
                ConflictResolution::KeepLocal
            });
        assert!(decision.adopted_fields.is_empty());
        assert_eq!(decision.kept_local, vec!["title".to_string()]);
    }

    #[test]
    fn read_only_fields_are_never_adopted() {
        let metadata = SyncMetadata::default();
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({ "title": "T", "assignee": "alice" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert_eq!(decision.adopted_fields.len(), 1);
        assert!(decision.adopted_fields.contains_key("title"));
        assert!(!decision.adopted_fields.contains_key("assignee"));
    }

    #[test]
    fn missing_remote_field_is_skipped() {
        let metadata = SyncMetadata::default();
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            // Only `title` present; the resolver must not invent
            // a `null` for `status`.
            json!({ "title": "T" }),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert!(!decision.adopted_fields.contains_key("status"));
        assert!(!decision.kept_local.iter().any(|n| n == "status"));
    }

    #[test]
    fn delete_short_circuits_field_walk() {
        let metadata = metadata_with(&[("title", 1_500_000_000_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!({}),
            true,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert!(decision.is_delete);
        assert!(decision.adopted_fields.is_empty());
        assert!(decision.kept_local.is_empty());
    }

    #[test]
    fn non_object_fields_treated_as_noop() {
        let metadata = SyncMetadata::default();
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_000_000).unwrap(),
            json!("not-an-object"),
            false,
        );
        let decision = resolve(&inbound, &metadata, &StubAdapter);
        assert!(decision.adopted_fields.is_empty());
        assert!(!decision.is_delete);
    }

    /// Two adapters covering the same field shouldn't fight: the
    /// second one's revision (with the later mtime) wins. Verifies
    /// that the resolver doesn't special-case "same source as the
    /// existing revision".
    #[test]
    fn cross_adapter_revisions_compare_purely_on_mtime() {
        let metadata = metadata_with(&[("title", 1_500_000_000_000, "linear")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_600_000_000_000).unwrap(),
            json!({ "title": "Newer github value" }),
            false,
        );
        let decision =
            resolve_with_policy(&inbound, &metadata, "github", &STUB_FIELD_MAP, None, |_| {
                ConflictResolution::UseRemote
            });
        assert_eq!(decision.adopted_fields["title"], "Newer github value");
        assert_eq!(decision.new_revisions["title"].source, "github");
    }

    /// The critical collab-merge case: the inbound row is a WHOLE-ROW snapshot
    /// (every field present), but the remote author only changed `title`. With
    /// per-field mtimes, the untouched `status` must NOT overwrite a newer
    /// local edit, and `title` (which the remote genuinely changed newer) is
    /// adopted.
    #[test]
    fn per_field_mtimes_protect_untouched_fields_from_stale_whole_row() {
        // Local edited `status` at 10:00:00; `title` last synced at 09:00:00.
        let metadata = metadata_with(&[
            ("status", 1_700_000_600_000, "local"),
            ("title", 1_700_000_000_000, "collab"),
        ]);
        // Remote pushed a whole-row snapshot: it changed `title` at 10:00:05
        // but carries a STALE `status` it never touched (its mtime is old).
        // Fields are keyed by LOCAL field name (the resolver looks up
        // `remote_obj.get(local_name)`), so `status`, not the remote "state".
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_605_000).unwrap(),
            json!({ "title": "Remote new title", "status": "stale-status" }),
            false,
        );
        let mut mtimes = HashMap::new();
        mtimes.insert("title".to_string(), 1_700_000_605_000_i64);
        // `status` deliberately absent — the remote author did not touch it.

        let decision = resolve_with_policy(
            &inbound,
            &metadata,
            "collab",
            &STUB_FIELD_MAP,
            Some(&mtimes),
            |_| ConflictResolution::UseRemote,
        );

        assert_eq!(decision.adopted_fields["title"], "Remote new title");
        assert_eq!(decision.new_revisions["title"].mtime, 1_700_000_605_000);
        // The untouched, newer-locally `status` is preserved, not reverted.
        assert!(!decision.adopted_fields.contains_key("status"));
        assert!(decision.kept_local.iter().any(|n| n == "status"));
    }

    /// A field present in the per-field map but OLDER than the local edit is
    /// kept local (same-field latest-wins still holds under per-field mtimes).
    #[test]
    fn per_field_mtimes_keep_local_when_local_edit_is_newer() {
        let metadata = metadata_with(&[("title", 1_700_000_600_000, "local")]);
        let inbound = change(
            Utc.timestamp_millis_opt(1_700_000_605_000).unwrap(),
            json!({ "title": "Older remote title" }),
            false,
        );
        let mut mtimes = HashMap::new();
        mtimes.insert("title".to_string(), 1_700_000_100_000_i64); // older than local

        let decision = resolve_with_policy(
            &inbound,
            &metadata,
            "collab",
            &STUB_FIELD_MAP,
            Some(&mtimes),
            |_| ConflictResolution::UseRemote,
        );

        assert!(decision.adopted_fields.is_empty());
        assert_eq!(decision.kept_local, vec!["title".to_string()]);
    }
}
