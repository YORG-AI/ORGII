//! Routine application service (`orgtrack/v1`).
//!
//! Owns the portable Routine domain: spec validation/canonicalization
//! ([`spec`]), versioned definitions with immutable per-run snapshots,
//! and RoutineRun materialization into generated WorkItems through the
//! same `work.create` handler every other entry point uses.
//!
//! Storage: `pm_routines` (current definition + revision) and
//! `pm_routine_runs` (immutable occurrence: revision, snapshot, hash,
//! status projection inputs). `routine_definitions` is the editable source;
//! `pm_routines` is its portable, rebuildable execution projection.

pub mod convert;
pub mod legacy_bridge;
pub mod spec;

use crate::projects::io as project_io;
use crate::projects::types::PERSONAL_ORG_ID;
use crate::work_service;

pub fn activation_from_trigger(
    trigger: &crate::projects::types::RoutineTrigger,
) -> spec::Activation {
    match trigger {
        crate::projects::types::RoutineTrigger::Cron { cron, timezone } => {
            spec::Activation::Schedule {
                cron: cron.clone(),
                timezone: timezone.clone(),
                policies: spec::ActivationPolicies::default(),
            }
        }
        crate::projects::types::RoutineTrigger::OneTime { at } => spec::Activation::OneTime {
            at: at.clone(),
            policies: spec::ActivationPolicies::default(),
        },
    }
}

pub fn trigger_from_activations(
    activations: &[spec::Activation],
) -> Option<crate::projects::types::RoutineTrigger> {
    activations.iter().find_map(activation_trigger)
}

pub fn next_occurrence_of_activations(
    activations: &[spec::Activation],
    now: &chrono::DateTime<chrono::Utc>,
) -> Result<Option<chrono::DateTime<chrono::Utc>>, String> {
    let mut earliest = None;
    for activation in activations {
        let Some(trigger) = activation_trigger(activation) else {
            continue;
        };
        let Some(next) = crate::projects::routine_schedule::next_occurrence(&trigger, now)? else {
            continue;
        };
        earliest = Some(match earliest {
            Some(current) if current <= next => current,
            _ => next,
        });
    }
    Ok(earliest)
}

fn activation_trigger(
    activation: &spec::Activation,
) -> Option<crate::projects::types::RoutineTrigger> {
    match activation {
        spec::Activation::Schedule { cron, timezone, .. } => {
            Some(crate::projects::types::RoutineTrigger::Cron {
                cron: cron.clone(),
                timezone: timezone.clone(),
            })
        }
        spec::Activation::OneTime { at, .. } => {
            Some(crate::projects::types::RoutineTrigger::OneTime { at: at.clone() })
        }
        spec::Activation::Manual { .. } | spec::Activation::ProviderEvent { .. } => None,
    }
}

pub(crate) fn next_activation_at(
    file: &spec::RoutineSpecFile,
    after: &chrono::DateTime<chrono::Utc>,
) -> Result<Option<i64>, String> {
    let mut next = None;
    for trigger in file.spec.activations.iter().filter_map(activation_trigger) {
        let candidate = crate::projects::routine_schedule::next_occurrence(&trigger, after)?
            .map(|value| value.timestamp_millis());
        if let Some(candidate) = candidate {
            next = Some(next.map_or(candidate, |current: i64| current.min(candidate)));
        }
    }
    Ok(next)
}

/// Compute the immutable snapshot hash for a canonical spec body.
pub fn snapshot_hash(canonical: &str) -> String {
    // FNV-1a 64 over the canonical bytes, doubled for width. Not
    // cryptographic — the hash pins run provenance, it does not defend
    // against adversaries; swap for sha256 when a crypto dep lands in
    // this crate for other reasons.
    fn fnv1a(bytes: &[u8], seed: u64) -> u64 {
        let mut hash = 0xcbf2_9ce4_8422_2325u64 ^ seed;
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01B3);
        }
        hash
    }
    let a = fnv1a(canonical.as_bytes(), 0);
    let b = fnv1a(canonical.as_bytes(), 0x9E37_79B9_7F4A_7C15);
    format!("fnv1a:{a:016x}{b:016x}")
}

/// `routine.apply` (§12.1): validate, canonicalize, then create or bump
/// the definition. Same canonical body → same revision (idempotent);
/// changed body → revision + 1. Historic runs are never touched.
fn apply_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    spec_file: &spec::RoutineSpecFile,
) -> Result<AppliedRoutine, String> {
    let violations = spec::validate(spec_file);
    if !violations.is_empty() {
        let details = serde_json::to_string(&violations).unwrap_or_default();
        return Err(format!("{}:{}", error::SPEC_INVALID, details));
    }
    let canonical = spec::canonicalize(spec_file)?;
    let hash = snapshot_hash(&canonical);

    let existing: Option<(i64, String, bool)> = tx
        .query_row(
            "SELECT revision, spec_hash, enabled FROM pm_routines WHERE name = ?1",
            rusqlite::params![spec_file.metadata.name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? != 0)),
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("routine apply: {other}")),
        })?;

    let (revision, changed) = match existing {
        Some((revision, ref stored_hash, _)) if stored_hash == &hash => (revision, false),
        Some((revision, _, enabled)) => {
            let next = revision + 1;
            let next_fire_at = if enabled {
                next_activation_at(spec_file, &chrono::Utc::now())?
            } else {
                None
            };
            tx.execute(
                "UPDATE pm_routines
                 SET spec_json = ?2, spec_hash = ?3, revision = ?4,
                     last_evaluated_at = NULL, next_fire_at = ?5, updated_at = ?6
                 WHERE name = ?1",
                rusqlite::params![
                    spec_file.metadata.name,
                    canonical,
                    hash,
                    next,
                    next_fire_at,
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .map_err(|err| format!("routine apply: {err}"))?;
            (next, true)
        }
        None => {
            let next_fire_at = next_activation_at(spec_file, &chrono::Utc::now())?;
            tx.execute(
                "INSERT INTO pm_routines
                    (name, routine_id, spec_json, spec_hash, revision, enabled,
                     next_fire_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, 1, ?5, ?6, ?6)",
                rusqlite::params![
                    spec_file.metadata.name,
                    spec_file.metadata.id,
                    canonical,
                    hash,
                    next_fire_at,
                    chrono::Utc::now().timestamp_millis(),
                ],
            )
            .map_err(|err| format!("routine apply: {err}"))?;
            (1, true)
        }
    };

    if changed {
        let seq = work_service::audit::bump_change_seq(tx)?;
        work_service::audit::append_audit_event(
            tx,
            &work_service::audit::AuditEventRow {
                operation: "routine.apply",
                entity_type: "routine",
                entity_id: &spec_file.metadata.name,
                project_slug: None,
                org_id: None,
                actor: None,
                revision,
                seq,
                payload: serde_json::json!({ "specHash": hash }),
            },
        )?;
    }
    Ok(AppliedRoutine {
        name: spec_file.metadata.name.clone(),
        revision,
        spec_hash: hash,
        changed,
    })
}

pub fn apply(spec_file: &spec::RoutineSpecFile) -> Result<AppliedRoutine, String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("routine apply tx: {err}"))?;
    let applied = apply_in_transaction(&tx, spec_file)?;
    tx.commit()
        .map_err(|err| format!("routine apply commit: {err}"))?;
    Ok(applied)
}

#[derive(Debug)]
pub struct AppliedRoutine {
    pub name: String,
    pub revision: i64,
    pub spec_hash: String,
    pub changed: bool,
}

/// Typed error sentinels for the routine domain.
pub mod error {
    pub const SPEC_INVALID: &str = "PM_ERR:ROUTINE_SPEC_INVALID";
    pub const INPUTS_INVALID: &str = "PM_ERR:ROUTINE_INPUTS_INVALID";
}

/// Substitute `{{ inputs.<name> }}` template markers (with or without
/// inner spaces) in root-work templates. Declarative only.
fn substitute_inputs(
    template: &str,
    inputs: &std::collections::BTreeMap<String, String>,
) -> String {
    let mut result = template.to_string();
    for (name, value) in inputs {
        for marker in [
            format!("{{{{ inputs.{} }}}}", name),
            format!("{{{{inputs.{}}}}}", name),
        ] {
            result = result.replace(&marker, value);
        }
    }
    result
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvokedRun {
    pub run_id: String,
    pub root_short_id: String,
    /// step id -> generated child short id, in spec order.
    pub steps: Vec<(String, String)>,
}

/// Host-local target for one Routine invocation. The portable spec remains
/// deployment-agnostic; this value is supplied by CLI context, a scheduler
/// binding, or a webhook installation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum RoutineInvocationTarget {
    Project {
        project_slug: String,
    },
    Standalone {
        org_id: String,
    },
    ExistingProjectWork {
        project_slug: String,
        root_work_item_id: String,
    },
    ExistingStandaloneWork {
        org_id: String,
        root_work_item_id: String,
    },
}

impl RoutineInvocationTarget {
    pub fn project(project_slug: impl Into<String>) -> Self {
        Self::Project {
            project_slug: project_slug.into(),
        }
    }

    pub fn standalone(org_id: Option<&str>) -> Self {
        Self::Standalone {
            org_id: org_id.unwrap_or(PERSONAL_ORG_ID).to_string(),
        }
    }

    /// Stable host-binding representation persisted in
    /// `pm_routines.default_scope`. Plain strings remain compatible with the
    /// original project-slug binding.
    pub fn to_binding(&self) -> String {
        match self {
            Self::Project { project_slug } => project_slug.clone(),
            Self::Standalone { org_id } => format!("org:{org_id}"),
            Self::ExistingProjectWork {
                project_slug,
                root_work_item_id,
            } => format!("work://project/{project_slug}/{root_work_item_id}"),
            Self::ExistingStandaloneWork {
                org_id,
                root_work_item_id,
            } => format!("work://org/{org_id}/{root_work_item_id}"),
        }
    }

    pub fn from_binding(binding: &str) -> Result<Self, String> {
        if let Some(rest) = binding.strip_prefix("work://project/") {
            let (project_slug, root_work_item_id) = rest
                .rsplit_once('/')
                .ok_or_else(|| format!("invalid project root-work Routine binding '{binding}'"))?;
            if project_slug.trim().is_empty() || root_work_item_id.trim().is_empty() {
                return Err(format!(
                    "invalid project root-work Routine binding '{binding}'"
                ));
            }
            return Ok(Self::ExistingProjectWork {
                project_slug: project_slug.to_string(),
                root_work_item_id: root_work_item_id.to_string(),
            });
        }
        if let Some(rest) = binding.strip_prefix("work://org/") {
            let (org_id, root_work_item_id) = rest
                .rsplit_once('/')
                .ok_or_else(|| format!("invalid org root-work Routine binding '{binding}'"))?;
            if org_id.trim().is_empty() || root_work_item_id.trim().is_empty() {
                return Err(format!("invalid org root-work Routine binding '{binding}'"));
            }
            return Ok(Self::ExistingStandaloneWork {
                org_id: org_id.to_string(),
                root_work_item_id: root_work_item_id.to_string(),
            });
        }
        if let Some(org_id) = binding.strip_prefix("org:") {
            if org_id.trim().is_empty() {
                return Err(format!("invalid org Routine binding '{binding}'"));
            }
            return Ok(Self::Standalone {
                org_id: org_id.to_string(),
            });
        }
        if binding.trim().is_empty() {
            return Err("Routine target binding must not be empty".to_string());
        }
        Ok(Self::project(binding))
    }
}

#[derive(Debug)]
struct ResolvedInvocationScope {
    scope_id: String,
    project_slug: Option<String>,
    project_id: Option<String>,
    org_id: String,
    existing_root: Option<String>,
}

fn canonical_standalone_org_id(
    tx: &rusqlite::Transaction<'_>,
    raw_org_id: &str,
) -> Result<String, String> {
    use rusqlite::OptionalExtension;

    let bare = raw_org_id
        .trim()
        .strip_prefix("cloud:")
        .unwrap_or(raw_org_id.trim());
    if bare.is_empty() || bare == PERSONAL_ORG_ID {
        return Ok(PERSONAL_ORG_ID.to_string());
    }
    let exists = tx
        .query_row(
            "SELECT 1 FROM project_orgs WHERE id = ?1",
            rusqlite::params![bare],
            |_| Ok(()),
        )
        .optional()
        .map_err(|err| format!("routine target org lookup: {err}"))?
        .is_some();
    Ok(if exists {
        bare.to_string()
    } else {
        PERSONAL_ORG_ID.to_string()
    })
}

fn resolve_invocation_scope(
    tx: &rusqlite::Transaction<'_>,
    target: &RoutineInvocationTarget,
) -> Result<ResolvedInvocationScope, String> {
    use rusqlite::OptionalExtension;

    match target {
        RoutineInvocationTarget::Project { project_slug }
        | RoutineInvocationTarget::ExistingProjectWork {
            project_slug,
            root_work_item_id: _,
        } => {
            let (project_id, org_id) = project_io::resolve_project_scope_in_tx(tx, project_slug)?;
            let existing_root = match target {
                RoutineInvocationTarget::ExistingProjectWork {
                    root_work_item_id, ..
                } => {
                    let exists = tx
                        .query_row(
                            "SELECT 1 FROM workitems
                              WHERE project_id = ?1 AND short_id = ?2 AND deleted_at IS NULL",
                            rusqlite::params![project_id, root_work_item_id],
                            |_| Ok(()),
                        )
                        .optional()
                        .map_err(|err| format!("routine root-work lookup: {err}"))?
                        .is_some();
                    if !exists {
                        return Err(format!(
                            "Root Work Item '{}' not found in project '{}'",
                            root_work_item_id, project_slug
                        ));
                    }
                    Some(root_work_item_id.clone())
                }
                _ => None,
            };
            Ok(ResolvedInvocationScope {
                scope_id: project_slug.clone(),
                project_slug: Some(project_slug.clone()),
                project_id: Some(project_id),
                org_id,
                existing_root,
            })
        }
        RoutineInvocationTarget::Standalone { org_id }
        | RoutineInvocationTarget::ExistingStandaloneWork {
            org_id,
            root_work_item_id: _,
        } => {
            let org_id = canonical_standalone_org_id(tx, org_id)?;
            let existing_root = match target {
                RoutineInvocationTarget::ExistingStandaloneWork {
                    root_work_item_id, ..
                } => {
                    let exists = tx
                        .query_row(
                            "SELECT 1 FROM workitems
                              WHERE project_id IS NULL AND org_id = ?1
                                AND short_id = ?2 AND deleted_at IS NULL",
                            rusqlite::params![org_id, root_work_item_id],
                            |_| Ok(()),
                        )
                        .optional()
                        .map_err(|err| format!("routine root-work lookup: {err}"))?
                        .is_some();
                    if !exists {
                        return Err(format!(
                            "Root Work Item '{}' not found in org '{}'",
                            root_work_item_id, org_id
                        ));
                    }
                    Some(root_work_item_id.clone())
                }
                _ => None,
            };
            Ok(ResolvedInvocationScope {
                scope_id: format!("org:{org_id}"),
                project_slug: None,
                project_id: None,
                org_id,
                existing_root,
            })
        }
    }
}

/// `routine.invoke` (§12.2): snapshot the current revision, create the
/// RoutineRun, materialize the root WorkItem and one generated child per
/// step through the canonical `work.create` handler, and record the
/// dependency edges as durable `depends_on` relations. Scheduler and
/// manual invocations share this single entry point.
pub fn invoke(
    routine_name: &str,
    scope_project_slug: &str,
    inputs: &std::collections::BTreeMap<String, String>,
    created_by: Option<&crate::projects::types::WorkItemMutationActor>,
    invoke_key: Option<&str>,
) -> Result<InvokedRun, String> {
    invoke_target(
        routine_name,
        &RoutineInvocationTarget::project(scope_project_slug),
        inputs,
        created_by,
        invoke_key,
    )
}

/// Target-aware Routine invoke used by `--root-work`, projectless webhook
/// delivery, and scheduled host bindings.
pub fn invoke_target(
    routine_name: &str,
    target: &RoutineInvocationTarget,
    inputs: &std::collections::BTreeMap<String, String>,
    created_by: Option<&crate::projects::types::WorkItemMutationActor>,
    invoke_key: Option<&str>,
) -> Result<InvokedRun, String> {
    let connection = project_io::helpers::conn()?;
    let (spec_json, spec_hash, revision, routine_id): (String, String, i64, String) = connection
        .query_row(
            "SELECT spec_json, spec_hash, revision, routine_id FROM pm_routines WHERE name = ?1",
            rusqlite::params![routine_name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => {
                format!("Routine '{}' not found", routine_name)
            }
            other => format!("routine invoke: {other}"),
        })?;
    // Provenance display name follows the editable definition; a portable-only
    // Routine (CLI-applied spec, no definition row) keeps its portable name.
    let definition_name = project_io::read_routine_in(&connection, &routine_id)
        .ok()
        .map(|definition| definition.name);
    drop(connection);
    let snapshot: spec::RoutineSpecFile =
        serde_json::from_str(&spec_json).map_err(|err| format!("snapshot parse: {err}"))?;

    for (name, decl) in &snapshot.spec.inputs {
        if decl.required && !inputs.contains_key(name) {
            return Err(format!(
                "{}:missing required input '{}'",
                error::INPUTS_INVALID,
                name
            ));
        }
    }
    for name in inputs.keys() {
        if !snapshot.spec.inputs.contains_key(name) {
            return Err(format!(
                "{}:unknown input '{}'",
                error::INPUTS_INVALID,
                name
            ));
        }
    }

    let now = chrono::Utc::now().timestamp_millis();
    // UUID identity is independent of wall-clock resolution. In particular,
    // `always` activations may legitimately materialize several runs in the
    // same millisecond and must never collide on the primary key.
    let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
    let actor_id = created_by
        .map(|actor| actor.id.as_str())
        .unwrap_or("system");
    let canonical_request = serde_json::json!({
        "routine": routine_name,
        "target": target,
        "inputs": inputs,
    });
    let canonical = serde_json::to_string(&canonical_request)
        .map_err(|err| format!("routine invoke canonicalize: {err}"))?;

    // The whole graph — idempotency check, id allocation, every item,
    // every relation, the run row, all audit rows and one watermark bump
    // — commits or rolls back as a unit.
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("routine invoke tx: {err}"))?;

    let resolved_scope = resolve_invocation_scope(&tx, target)?;
    if let Some(key) = invoke_key {
        let existing: Option<(String, Option<String>)> = tx
            .query_row(
                "SELECT request_hash, response_json FROM pm_idempotency
                 WHERE actor_id = ?1 AND operation = 'routine.invoke' AND scope_id = ?2 AND idem_key = ?3",
                rusqlite::params![actor_id, resolved_scope.scope_id, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map(Some)
            .or_else(|err| match err {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(format!("routine invoke idempotency: {other}")),
            })?;
        if let Some((stored_request, stored_response)) = existing {
            if stored_request != canonical {
                return Err(format!(
                    "{}:routine.invoke:{}",
                    work_service::error::IDEMPOTENCY_CONFLICT,
                    key
                ));
            }
            let replayed: InvokedRun = stored_response
                .as_deref()
                .and_then(|raw| serde_json::from_str(raw).ok())
                .ok_or_else(|| "routine invoke replay: stored response unreadable".to_string())?;
            return Ok(replayed);
        }
    }

    let seq = work_service::audit::bump_change_seq(&tx)?;

    // Every item this run materializes carries the Routine it came from, so
    // the Work Item surfaces keep provenance no matter which activation path
    // (manual, scheduler, webhook, CLI) produced the run.
    let routine_source = crate::projects::types::WorkItemRoutineSource {
        routine_id: routine_id.clone(),
        routine_fire_id: run_id.clone(),
        routine_name: definition_name.unwrap_or_else(|| routine_name.to_string()),
        fired_at: chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now)
            .unwrap_or_else(chrono::Utc::now)
            .to_rfc3339(),
    };

    let create_item =
        |short_id: &str, request: &work_service::CreateWorkItemRequest| -> Result<(), String> {
            work_service::guard_new_work_item_id_in_tx(&tx, short_id)?;
            let frontmatter =
                work_service::build_frontmatter_for_graph(short_id, request, Some(&routine_source));
            project_io::write_work_item_in_tx(
                &tx,
                resolved_scope.project_id.clone(),
                &resolved_scope.org_id,
                short_id,
                &frontmatter,
                &request.body,
                true,
            )?;
            // The generated item and its collaboration delivery intent are
            // one atomic write. An empty field path denotes a full snapshot,
            // matching `record_work_item_write` without opening a second
            // post-commit connection.
            crate::sync::collab_bridge::record_work_item_payload_touch_in_connection(
                &tx,
                &resolved_scope.org_id,
                resolved_scope.project_slug.as_deref(),
                &frontmatter.id,
                "",
            )?;
            work_service::audit::append_audit_event(
                &tx,
                &work_service::audit::AuditEventRow {
                    operation: "work.create",
                    entity_type: "work_item",
                    entity_id: short_id,
                    project_slug: resolved_scope.project_slug.as_deref(),
                    org_id: resolved_scope
                        .project_slug
                        .is_none()
                        .then_some(resolved_scope.org_id.as_str()),
                    actor: created_by,
                    revision: 0,
                    seq,
                    payload: serde_json::json!({}),
                },
            )?;
            if let Some(actor) = created_by {
                let scope_key = resolved_scope
                    .project_slug
                    .as_deref()
                    .map(|slug| format!("project:{slug}"))
                    .unwrap_or_else(|| format!("org:{}", resolved_scope.org_id));
                tx.execute(
                    "INSERT INTO pm_work_item_subscriptions (
                         scope_key, work_item_id, subscriber_id, reason, created_at, muted_at
                     ) VALUES (?1, ?2, ?3, 'creator', ?4, NULL)
                     ON CONFLICT(scope_key, work_item_id, subscriber_id) DO UPDATE SET
                         muted_at = NULL",
                    rusqlite::params![scope_key, short_id, actor.id, now],
                )
                .map_err(|err| format!("routine creator subscription: {err}"))?;
            }
            Ok(())
        };

    let allocate_short_id = || -> Result<String, String> {
        match resolved_scope.project_slug.as_deref() {
            Some(project_slug) => project_io::allocate_short_id_in_tx(&tx, project_slug),
            None => project_io::allocate_standalone_short_id_in_tx(&tx, &resolved_scope.org_id),
        }
    };

    let root_short_id = if let Some(root_work_item_id) = &resolved_scope.existing_root {
        root_work_item_id.clone()
    } else {
        let root_short_id = allocate_short_id()?;
        let root_request = work_service::CreateWorkItemRequest {
            title: substitute_inputs(&snapshot.spec.root_work.title, inputs),
            body: snapshot
                .spec
                .root_work
                .body
                .as_deref()
                .map(|body| substitute_inputs(body, inputs))
                .unwrap_or_default(),
            priority: snapshot.spec.root_work.priority.clone(),
            labels: snapshot.spec.root_work.labels.clone(),
            created_by: created_by.map(|actor| actor.id.clone()),
            ..Default::default()
        };
        create_item(&root_short_id, &root_request)?;
        root_short_id
    };

    let mut step_ids: Vec<(String, String)> = Vec::new();
    for step in &snapshot.spec.steps {
        let child_short_id = allocate_short_id()?;
        let mut body = step
            .instruction
            .as_deref()
            .map(|instruction| substitute_inputs(instruction, inputs))
            .unwrap_or_default();
        if !step.inputs.is_empty() {
            body.push_str("\n\n## Inputs\n");
            for (name, expression) in &step.inputs {
                body.push_str(&format!("- {}: {}\n", name, expression));
            }
        }
        if let Some(actor_requirement) = &step.actor {
            body.push_str(&format!(
                "\n## Actor requirement\n- role: {}\n- requires: {}\n",
                actor_requirement.role,
                actor_requirement.requires.join(", ")
            ));
        }
        let child_request = work_service::CreateWorkItemRequest {
            title: substitute_inputs(&step.title, inputs),
            body,
            parent: Some(root_short_id.clone()),
            created_by: created_by.map(|actor| actor.id.clone()),
            ..Default::default()
        };
        create_item(&child_short_id, &child_request)?;
        step_ids.push((step.id.clone(), child_short_id));
    }

    let index: std::collections::HashMap<&str, &str> = step_ids
        .iter()
        .map(|(step_id, short_id)| (step_id.as_str(), short_id.as_str()))
        .collect();
    let relate_now = chrono::Utc::now().timestamp_millis();
    let insert_relation = |entity_id: &str, kind: &str, target_ref: &str| -> Result<(), String> {
        tx.execute(
            "INSERT INTO pm_relations (entity_type, entity_id, kind, target_ref, created_at, actor_id)
             VALUES ('work_item', ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![entity_id, kind, target_ref, relate_now, actor_id],
        )
        .map_err(|err| format!("routine invoke relation: {err}"))?;
        work_service::audit::append_audit_event(
            &tx,
            &work_service::audit::AuditEventRow {
                operation: "work.relate",
                entity_type: "work_item",
                entity_id,
                project_slug: resolved_scope.project_slug.as_deref(),
                org_id: resolved_scope
                    .project_slug
                    .is_none()
                    .then_some(resolved_scope.org_id.as_str()),
                actor: created_by,
                revision: 0,
                seq,
                payload: serde_json::json!({ "kind": kind, "targetRef": target_ref }),
            },
        )
    };
    for step in &snapshot.spec.steps {
        let child = index[step.id.as_str()];
        for need in &step.needs {
            insert_relation(
                child,
                "depends_on",
                &format!(
                    "work://{}/{}",
                    resolved_scope.scope_id,
                    index[need.as_str()]
                ),
            )?;
        }
        insert_relation(child, "generated_by", &format!("run://{}", run_id))?;
    }

    tx.execute(
        "INSERT INTO pm_routine_runs
            (id, routine_name, routine_revision, snapshot_json, snapshot_hash,
             scope_id, status, inputs_json, root_work_item_id, created_by,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, ?8, ?9, ?10, ?10)",
        rusqlite::params![
            run_id,
            routine_name,
            revision,
            spec_json,
            spec_hash,
            resolved_scope.scope_id,
            serde_json::to_string(inputs).unwrap_or_default(),
            root_short_id,
            created_by.map(|actor| actor.id.as_str()),
            now,
        ],
    )
    .map_err(|err| format!("routine invoke: {err}"))?;
    work_service::audit::append_audit_event(
        &tx,
        &work_service::audit::AuditEventRow {
            operation: "routine.invoke",
            entity_type: "routine_run",
            entity_id: &run_id,
            project_slug: resolved_scope.project_slug.as_deref(),
            org_id: resolved_scope
                .project_slug
                .is_none()
                .then_some(resolved_scope.org_id.as_str()),
            actor: created_by,
            revision,
            seq,
            payload: serde_json::json!({
                "routine": routine_name,
                "snapshotHash": spec_hash,
                "rootWorkItemId": root_short_id,
            }),
        },
    )?;

    let invoked = InvokedRun {
        run_id: run_id.clone(),
        root_short_id: root_short_id.clone(),
        steps: step_ids,
    };
    if let Some(key) = invoke_key {
        let response_raw = serde_json::to_string(&invoked)
            .map_err(|err| format!("routine invoke serialize: {err}"))?;
        tx.execute(
            "INSERT INTO pm_idempotency
                (actor_id, operation, scope_id, idem_key, request_hash, response_json, created_at)
             VALUES (?1, 'routine.invoke', ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                actor_id,
                resolved_scope.scope_id,
                key,
                canonical,
                response_raw,
                now
            ],
        )
        .map_err(|err| format!("routine invoke idempotency record: {err}"))?;
    }
    tx.commit()
        .map_err(|err| format!("routine invoke commit: {err}"))?;
    crate::projects::events::notify_work_item_schedule_changed();
    crate::projects::events::notify_routine_changed(
        crate::projects::events::RoutineChangedEvent {
            routine_id: routine_source.routine_id.clone(),
            fire_id: Some(run_id.clone()),
            status: "started".to_string(),
        },
    );

    Ok(invoked)
}

/// Set the host-local default scope binding used by scheduled invokes.
/// Deliberately outside the portable spec/hash — scope is deployment
/// configuration, not work-method knowledge.
pub fn set_default_scope(name: &str, scope: &str) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    let changed = connection
        .execute(
            "UPDATE pm_routines SET default_scope = ?2 WHERE name = ?1",
            rusqlite::params![name, scope],
        )
        .map_err(|err| format!("routine set_default_scope: {err}"))?;
    if changed == 0 {
        return Err(format!("Routine '{}' not found", name));
    }
    Ok(())
}

pub fn set_default_target(name: &str, target: &RoutineInvocationTarget) -> Result<(), String> {
    set_default_scope(name, &target.to_binding())
}

/// One schedule-activation candidate for the host scheduler tick.
#[derive(Debug)]
pub struct ScheduledCandidate {
    pub name: String,
    pub trigger: ScheduledTrigger,
    pub concurrency: spec::ConcurrencyPolicy,
    pub catch_up: spec::CatchUpPolicy,
    pub max_catch_up_runs: u32,
    pub target: RoutineInvocationTarget,
    pub last_evaluated_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub enum ScheduledTrigger {
    Cron { cron: String, timezone: String },
    OneTime { at: String },
}

/// A single durable tick never parses or starts more than this many
/// activations. Additional due rows retain their watermark and are picked up
/// by the next 30-second pass.
pub const MAX_SCHEDULE_CANDIDATES_PER_TICK: usize = 256;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineActivationEvent {
    pub id: String,
    pub routine_name: String,
    pub invoke_key: String,
    pub status: String,
    pub coalesced_run_id: Option<String>,
    pub error: Option<String>,
    pub scheduled_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub enum RoutineActivationOutcome {
    Invoked(InvokedRun),
    Deferred(RoutineActivationEvent),
}

#[derive(Debug, Clone)]
pub struct QueuedActivation {
    pub event_id: String,
    pub routine_name: String,
    pub invoke_key: String,
    pub target: RoutineInvocationTarget,
    pub inputs: std::collections::BTreeMap<String, String>,
}

fn read_activation_event_in(
    connection: &rusqlite::Connection,
    routine_name: &str,
    invoke_key: &str,
) -> Result<Option<RoutineActivationEvent>, String> {
    use rusqlite::OptionalExtension;
    connection
        .query_row(
            "SELECT id, routine_name, invoke_key, status, coalesced_run_id,
                    error, scheduled_at, created_at, updated_at
               FROM pm_routine_activation_events
              WHERE routine_name = ?1 AND invoke_key = ?2",
            rusqlite::params![routine_name, invoke_key],
            |row| {
                Ok(RoutineActivationEvent {
                    id: row.get(0)?,
                    routine_name: row.get(1)?,
                    invoke_key: row.get(2)?,
                    status: row.get(3)?,
                    coalesced_run_id: row.get(4)?,
                    error: row.get(5)?,
                    scheduled_at: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|err| format!("routine activation event: {err}"))
}

struct DeferredActivation<'a> {
    routine_name: &'a str,
    target: &'a RoutineInvocationTarget,
    inputs: &'a std::collections::BTreeMap<String, String>,
    invoke_key: &'a str,
    status: &'a str,
    active_run_id: Option<&'a str>,
    scheduled_at: i64,
}

fn record_deferred_activation_in(
    connection: &rusqlite::Connection,
    activation: DeferredActivation<'_>,
) -> Result<RoutineActivationEvent, String> {
    let DeferredActivation {
        routine_name,
        target,
        inputs,
        invoke_key,
        status,
        active_run_id,
        scheduled_at,
    } = activation;
    if let Some(existing) = read_activation_event_in(connection, routine_name, invoke_key)? {
        return Ok(existing);
    }
    let now = chrono::Utc::now().timestamp_millis();
    let id = format!("rae_{}", uuid::Uuid::new_v4().simple());
    let error = match status {
        "queued" => active_run_id.map(|id| format!("Queued behind active run {id}")),
        "skipped" => active_run_id.map(|id| format!("Skipped because run {id} is active")),
        "coalesced" => active_run_id.map(|id| format!("Coalesced into active run {id}")),
        _ => None,
    };
    connection
        .execute(
            "INSERT INTO pm_routine_activation_events (
                 id, routine_name, invoke_key, target_binding, inputs_json,
                 status, coalesced_run_id, error, scheduled_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
             ON CONFLICT(routine_name, invoke_key) DO NOTHING",
            rusqlite::params![
                id,
                routine_name,
                invoke_key,
                target.to_binding(),
                serde_json::to_string(inputs).unwrap_or_else(|_| "{}".to_string()),
                status,
                active_run_id,
                error,
                scheduled_at,
                now,
            ],
        )
        .map_err(|err| format!("routine activation event: {err}"))?;
    read_activation_event_in(connection, routine_name, invoke_key)?
        .ok_or_else(|| "routine activation event disappeared after insert".to_string())
}

fn record_deferred_activation(
    routine_name: &str,
    target: &RoutineInvocationTarget,
    inputs: &std::collections::BTreeMap<String, String>,
    invoke_key: &str,
    status: &str,
    active_run_id: Option<&str>,
    scheduled_at: i64,
) -> Result<RoutineActivationEvent, String> {
    let connection = project_io::helpers::conn()?;
    record_deferred_activation_in(
        &connection,
        DeferredActivation {
            routine_name,
            target,
            inputs,
            invoke_key,
            status,
            active_run_id,
            scheduled_at,
        },
    )
}

const ACTIVATION_GUARD_LEASE_MS: i64 = 60_000;

struct ActivationGuard {
    routine_name: String,
    owner_token: String,
    released: bool,
}

impl ActivationGuard {
    fn renew(&mut self) -> Result<(), String> {
        let connection = project_io::helpers::conn()?;
        let now = chrono::Utc::now().timestamp_millis();
        let changed = connection
            .execute(
                "UPDATE pm_routine_activation_guards
                    SET lease_expires_at = ?3
                  WHERE routine_name = ?1 AND owner_token = ?2",
                rusqlite::params![
                    self.routine_name,
                    self.owner_token,
                    now + ACTIVATION_GUARD_LEASE_MS
                ],
            )
            .map_err(|err| format!("routine activation guard renew: {err}"))?;
        if changed != 1 {
            return Err(format!(
                "Routine activation guard ownership lost for '{}'",
                self.routine_name
            ));
        }
        Ok(())
    }

    fn release(&mut self) -> Result<(), String> {
        if self.released {
            return Ok(());
        }
        let connection = project_io::helpers::conn()?;
        connection
            .execute(
                "DELETE FROM pm_routine_activation_guards
                  WHERE routine_name = ?1 AND owner_token = ?2",
                rusqlite::params![self.routine_name, self.owner_token],
            )
            .map_err(|err| format!("routine activation guard release: {err}"))?;
        self.released = true;
        Ok(())
    }
}

impl Drop for ActivationGuard {
    fn drop(&mut self) {
        let _ = self.release();
    }
}

enum ActivationGuardClaim {
    Acquired(ActivationGuard),
    Busy,
}

/// Linearization point for non-`always` activation decisions. The immediate
/// transaction makes the CAS visible across threads and processes. The guard
/// remains owned through active-check and durable defer/invoke creation; a
/// crashed owner is recoverable after the short lease.
fn claim_activation_guard(routine_name: &str) -> Result<ActivationGuardClaim, String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("routine activation guard tx: {err}"))?;
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "DELETE FROM pm_routine_activation_guards
          WHERE routine_name = ?1 AND lease_expires_at <= ?2",
        rusqlite::params![routine_name, now],
    )
    .map_err(|err| format!("routine activation guard expiry: {err}"))?;
    let owner_token = uuid::Uuid::new_v4().simple().to_string();
    let inserted = tx
        .execute(
            "INSERT INTO pm_routine_activation_guards (
                 routine_name, owner_token, lease_expires_at, created_at
             ) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(routine_name) DO NOTHING",
            rusqlite::params![
                routine_name,
                owner_token,
                now + ACTIVATION_GUARD_LEASE_MS,
                now
            ],
        )
        .map_err(|err| format!("routine activation guard claim: {err}"))?;
    if inserted == 1 {
        tx.commit()
            .map_err(|err| format!("routine activation guard commit: {err}"))?;
        return Ok(ActivationGuardClaim::Acquired(ActivationGuard {
            routine_name: routine_name.to_string(),
            owner_token,
            released: false,
        }));
    }
    tx.commit()
        .map_err(|err| format!("routine activation guard commit: {err}"))?;
    Ok(ActivationGuardClaim::Busy)
}

/// Atomically verify the competing CAS owner and persist this activation's
/// losing policy decision. If the owner released between the initial CAS and
/// this transaction, return `None` so the caller retries the decision.
fn defer_behind_activation_guard(
    routine_name: &str,
    target: &RoutineInvocationTarget,
    inputs: &std::collections::BTreeMap<String, String>,
    invoke_key: &str,
    status: &str,
    scheduled_at: i64,
) -> Result<Option<RoutineActivationEvent>, String> {
    use rusqlite::OptionalExtension;

    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("routine activation defer tx: {err}"))?;
    let owner: Option<String> = tx
        .query_row(
            "SELECT owner_token FROM pm_routine_activation_guards WHERE routine_name = ?1",
            rusqlite::params![routine_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine activation guard owner: {err}"))?;
    let Some(owner) = owner else {
        tx.commit()
            .map_err(|err| format!("routine activation defer commit: {err}"))?;
        return Ok(None);
    };
    let active_decision = format!("activation:{owner}");
    let event = record_deferred_activation_in(
        &tx,
        DeferredActivation {
            routine_name,
            target,
            inputs,
            invoke_key,
            status,
            active_run_id: Some(&active_decision),
            scheduled_at,
        },
    )?;
    tx.commit()
        .map_err(|err| format!("routine activation defer commit: {err}"))?;
    Ok(Some(event))
}

/// Editable definition id behind a portable execution name, for the
/// fine-grained routine notification the Routines page listens on.
fn routine_id_for_name(routine_name: &str) -> Option<String> {
    let connection = project_io::helpers::conn().ok()?;
    connection
        .query_row(
            "SELECT routine_id FROM pm_routines WHERE name = ?1",
            rusqlite::params![routine_name],
            |row| row.get::<_, String>(0),
        )
        .ok()
}

fn notify_activation_recorded(routine_name: &str, event: &RoutineActivationEvent) {
    let Some(routine_id) = routine_id_for_name(routine_name) else {
        return;
    };
    crate::projects::events::notify_routine_changed(
        crate::projects::events::RoutineChangedEvent {
            routine_id,
            fire_id: Some(event.id.clone()),
            status: event.status.clone(),
        },
    );
}

/// Apply portable concurrency semantics at the owning boundary. Queue,
/// coalesce and skip outcomes are durable; `always` intentionally bypasses
/// the active-run gate.
pub fn request_activation(
    routine_name: &str,
    target: &RoutineInvocationTarget,
    inputs: &std::collections::BTreeMap<String, String>,
    invoke_key: &str,
    policy: spec::ConcurrencyPolicy,
    scheduled_at: i64,
) -> Result<RoutineActivationOutcome, String> {
    let connection = project_io::helpers::conn()?;
    if let Some(existing) = read_activation_event_in(&connection, routine_name, invoke_key)? {
        return Ok(RoutineActivationOutcome::Deferred(existing));
    }
    if policy == spec::ConcurrencyPolicy::Always {
        return invoke_target(routine_name, target, inputs, None, Some(invoke_key))
            .map(RoutineActivationOutcome::Invoked);
    }

    let status = match policy {
        spec::ConcurrencyPolicy::Queue => "queued",
        spec::ConcurrencyPolicy::Coalesce => "coalesced",
        spec::ConcurrencyPolicy::Skip => "skipped",
        spec::ConcurrencyPolicy::Always => unreachable!(),
    };
    let mut guard = loop {
        match claim_activation_guard(routine_name)? {
            ActivationGuardClaim::Acquired(guard) => break guard,
            ActivationGuardClaim::Busy => {
                if let Some(event) = defer_behind_activation_guard(
                    routine_name,
                    target,
                    inputs,
                    invoke_key,
                    status,
                    scheduled_at,
                )? {
                    notify_activation_recorded(routine_name, &event);
                    return Ok(RoutineActivationOutcome::Deferred(event));
                }
                // The owner completed between the CAS and the defer
                // transaction. Re-enter the CAS and observe its durable run.
                continue;
            }
        }
    };
    let connection = project_io::helpers::conn()?;
    let outcome =
        if let Some(existing) = read_activation_event_in(&connection, routine_name, invoke_key)? {
            Ok(RoutineActivationOutcome::Deferred(existing))
        } else if let Some(active_run_id) = active_run_id(routine_name)? {
            record_deferred_activation(
                routine_name,
                target,
                inputs,
                invoke_key,
                status,
                Some(&active_run_id),
                scheduled_at,
            )
            .map(|event| {
                notify_activation_recorded(routine_name, &event);
                RoutineActivationOutcome::Deferred(event)
            })
        } else {
            guard.renew()?;
            invoke_target(routine_name, target, inputs, None, Some(invoke_key))
                .map(RoutineActivationOutcome::Invoked)
        };
    let _ = guard.release();
    outcome
}

/// Promote one queued activation under the same cross-process CAS as a fresh
/// activation decision. `Ok(None)` means another activation owns the guard or
/// a non-terminal run still exists; the durable queue row remains untouched.
pub fn promote_queued_activation(queued: &QueuedActivation) -> Result<Option<InvokedRun>, String> {
    let mut guard = match claim_activation_guard(&queued.routine_name)? {
        ActivationGuardClaim::Acquired(guard) => guard,
        ActivationGuardClaim::Busy => return Ok(None),
    };
    let outcome = if has_active_run(&queued.routine_name)? {
        Ok(None)
    } else {
        guard.renew()?;
        let invoked = invoke_target(
            &queued.routine_name,
            &queued.target,
            &queued.inputs,
            None,
            Some(&queued.invoke_key),
        )?;
        finish_queued_activation(&queued.event_id, None)?;
        Ok(Some(invoked))
    };
    let _ = guard.release();
    outcome
}

pub fn queued_activations(limit: usize) -> Result<Vec<QueuedActivation>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT event.id, event.routine_name, event.invoke_key,
                    event.target_binding, event.inputs_json
               FROM pm_routine_activation_events event
               JOIN pm_routines routine ON routine.name = event.routine_name
              WHERE event.status = 'queued'
              ORDER BY event.created_at, event.id
              LIMIT ?1",
        )
        .map_err(|err| format!("routine activation queue: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![limit.clamp(1, 256) as i64], |row| {
            let binding: String = row.get(3)?;
            let inputs_json: String = row.get(4)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                binding,
                inputs_json,
            ))
        })
        .map_err(|err| format!("routine activation queue: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine activation queue: {err}"))?;
    rows.into_iter()
        .map(
            |(event_id, routine_name, invoke_key, binding, inputs_json)| {
                Ok(QueuedActivation {
                    event_id,
                    routine_name,
                    invoke_key,
                    target: RoutineInvocationTarget::from_binding(&binding)?,
                    inputs: serde_json::from_str(&inputs_json)
                        .map_err(|err| format!("routine activation queue inputs: {err}"))?,
                })
            },
        )
        .collect()
}

pub fn finish_queued_activation(event_id: &str, error: Option<&str>) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    let (status, error) = match error {
        Some(error) => ("failed", Some(error)),
        None => ("dispatched", None),
    };
    connection
        .execute(
            "UPDATE pm_routine_activation_events
                SET status = ?2, error = ?3, updated_at = ?4
              WHERE id = ?1 AND status = 'queued'",
            rusqlite::params![
                event_id,
                status,
                error,
                chrono::Utc::now().timestamp_millis()
            ],
        )
        .map_err(|err| format!("routine activation queue finish: {err}"))?;
    Ok(())
}

/// Enabled routines with schedule activations, for the host scheduler.
pub fn scheduled_candidates(evaluate_before: i64) -> Result<Vec<ScheduledCandidate>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT name, spec_json, default_scope, last_evaluated_at
             FROM pm_routines
             WHERE enabled = 1
               AND (instr(spec_json, '\"type\":\"schedule\"') > 0
                    OR instr(spec_json, '\"type\":\"one_time\"') > 0)
               AND (next_fire_at IS NULL OR next_fire_at <= ?1)
             ORDER BY next_fire_at, name
             LIMIT ?2",
        )
        .map_err(|err| format!("scheduled candidates: {err}"))?;
    let rows: Vec<(String, String, Option<String>, Option<i64>)> = statement
        .query_map(
            rusqlite::params![evaluate_before, MAX_SCHEDULE_CANDIDATES_PER_TICK as i64],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|err| format!("scheduled candidates: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("scheduled candidates: {err}"))?;
    let mut candidates = Vec::new();
    for (name, spec_json, default_scope, last_evaluated_at) in rows {
        let target = default_scope
            .as_deref()
            .map(RoutineInvocationTarget::from_binding)
            .transpose()?
            .unwrap_or_else(|| RoutineInvocationTarget::standalone(None));
        let Ok(file) = serde_json::from_str::<spec::RoutineSpecFile>(&spec_json) else {
            continue;
        };
        for activation in &file.spec.activations {
            let (trigger, policies) = match activation {
                spec::Activation::Schedule {
                    cron,
                    timezone,
                    policies,
                } => (
                    ScheduledTrigger::Cron {
                        cron: cron.clone(),
                        timezone: timezone.clone(),
                    },
                    policies,
                ),
                spec::Activation::OneTime { at, policies } => {
                    (ScheduledTrigger::OneTime { at: at.clone() }, policies)
                }
                spec::Activation::Manual { .. } | spec::Activation::ProviderEvent { .. } => {
                    continue
                }
            };
            candidates.push(ScheduledCandidate {
                name: name.clone(),
                trigger,
                concurrency: policies
                    .concurrency_policy
                    .unwrap_or(spec::ConcurrencyPolicy::Skip),
                catch_up: policies.catch_up.unwrap_or(spec::CatchUpPolicy::None),
                max_catch_up_runs: policies.max_catch_up_runs.unwrap_or(1).max(1),
                target: target.clone(),
                last_evaluated_at,
            });
            if candidates.len() == MAX_SCHEDULE_CANDIDATES_PER_TICK {
                return Ok(candidates);
            }
        }
    }
    Ok(candidates)
}

/// Persist the scheduler watermark after an evaluation pass.
pub fn mark_evaluated(
    name: &str,
    evaluated_at: i64,
    next_fire_at: Option<i64>,
) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    connection
        .execute(
            "UPDATE pm_routines SET last_evaluated_at = ?2, next_fire_at = ?3 WHERE name = ?1",
            rusqlite::params![name, evaluated_at, next_fire_at],
        )
        .map_err(|err| format!("routine mark_evaluated: {err}"))?;
    Ok(())
}

/// True when the routine has a non-terminal run (running or pending).
/// Stored 'running' runs whose generated items are all terminal get their
/// outcome written back so they stop suppressing the next scheduled fire.
pub fn has_active_run(name: &str) -> Result<bool, String> {
    Ok(active_run_id(name)?.is_some())
}

pub fn active_run_id(name: &str) -> Result<Option<String>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, status, scope_id FROM pm_routine_runs
             WHERE routine_name = ?1 AND status IN ('running', 'pending')",
        )
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    let candidates: Vec<(String, String, String)> = statement
        .query_map(rusqlite::params![name], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|err| format!("routine has_active_run: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    drop(statement);
    drop(connection);

    for (run_id, status, scope_id) in candidates {
        if status == "pending" {
            return Ok(Some(run_id));
        }
        if reconcile_running_run(&run_id, &scope_id)? {
            return Ok(Some(run_id));
        }
    }
    // During upgrade a legacy fire that already launched may still be
    // running. Keep portable Queue/Skip/Coalesce semantics aware of it so the
    // execution projection cannot double-start that occurrence.
    use rusqlite::OptionalExtension;
    let connection = project_io::helpers::conn()?;
    let legacy_fire_id: Option<String> = connection
        .query_row(
            "SELECT fire.id
               FROM pm_routines routine
               JOIN routine_fires fire ON fire.routine_id = routine.routine_id
              WHERE routine.name = ?1
                AND fire.status = 'started'
              ORDER BY fire.fired_at DESC
              LIMIT 1",
            rusqlite::params![name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|err| format!("routine legacy handover activity: {err}"))?;
    Ok(legacy_fire_id.map(|id| format!("legacy:{id}")))
}

fn reconcile_running_run(run_id: &str, scope_id: &str) -> Result<bool, String> {
    use work_service::WorkItemState::{Cancelled, Completed, Failed};

    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT entity_id FROM pm_relations
             WHERE kind = 'generated_by' AND target_ref = ?1
             ORDER BY id",
        )
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    let child_ids: Vec<String> = statement
        .query_map(rusqlite::params![format!("run://{run_id}")], |row| {
            row.get(0)
        })
        .map_err(|err| format!("routine has_active_run: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    drop(statement);
    drop(connection);

    if child_ids.is_empty() {
        return Ok(true);
    }

    let mut states = Vec::new();
    for child_id in &child_ids {
        let Ok(item) = read_scoped_work_item(scope_id, child_id) else {
            return Ok(true);
        };
        states.push(work_service::state::map_legacy_status(
            &item.frontmatter.status,
        ));
    }

    let all_terminal = states
        .iter()
        .all(|state| matches!(state, Some(Completed) | Some(Failed) | Some(Cancelled)));
    if !all_terminal {
        return Ok(true);
    }

    let outcome = if states.contains(&Some(Failed)) {
        "failed"
    } else if states.iter().all(|state| *state == Some(Completed)) {
        "succeeded"
    } else {
        "cancelled"
    };

    let connection = project_io::helpers::conn()?;
    connection
        .execute(
            "UPDATE pm_routine_runs SET status = ?2 WHERE id = ?1 AND status = 'running'",
            rusqlite::params![run_id, outcome],
        )
        .map_err(|err| format!("routine has_active_run: {err}"))?;
    Ok(false)
}

fn read_scoped_work_item(
    scope_id: &str,
    short_id: &str,
) -> Result<crate::projects::types::WorkItemData, String> {
    match scope_id.strip_prefix("org:") {
        Some(org_id) => project_io::read_standalone_work_item(Some(org_id), short_id),
        None => project_io::read_work_item(scope_id, short_id),
    }
}

/// Audit a suppressed automatic fire (skip/coalesce/queue while active).
pub fn audit_suppressed_fire(name: &str, policy: &str, scheduled_at: i64) -> Result<(), String> {
    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction()
        .map_err(|err| format!("suppressed fire tx: {err}"))?;
    let seq = work_service::audit::bump_change_seq(&tx)?;
    work_service::audit::append_audit_event(
        &tx,
        &work_service::audit::AuditEventRow {
            operation: "routine.fire_suppressed",
            entity_type: "routine",
            entity_id: name,
            project_slug: None,
            org_id: None,
            actor: None,
            revision: 0,
            seq,
            payload: serde_json::json!({ "policy": policy, "scheduledAt": scheduled_at }),
        },
    )?;
    tx.commit()
        .map_err(|err| format!("suppressed fire commit: {err}"))
}

/// List routine definitions (name, revision, enabled, hash).
pub fn list_routines() -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT name, routine_id, revision, enabled, spec_hash, updated_at
             FROM pm_routines ORDER BY name",
        )
        .map_err(|err| format!("routine list: {err}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "name": row.get::<_, String>(0)?,
                "routineId": row.get::<_, String>(1)?,
                "revision": row.get::<_, i64>(2)?,
                "enabled": row.get::<_, i64>(3)? != 0,
                "specHash": row.get::<_, String>(4)?,
                "updatedAt": row.get::<_, i64>(5)?,
            }))
        })
        .map_err(|err| format!("routine list: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine list: {err}"))?;
    Ok(rows)
}

/// Enable/disable automatic activations. Manual `routine run` stays
/// available on disabled routines by contract.
pub fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let connection = project_io::helpers::conn()?;
    let changed = connection
        .execute(
            "UPDATE pm_routines SET enabled = ?2, updated_at = ?3 WHERE name = ?1",
            rusqlite::params![name, enabled as i64, chrono::Utc::now().timestamp_millis()],
        )
        .map_err(|err| format!("routine set_enabled: {err}"))?;
    if changed == 0 {
        return Err(format!("Routine '{}' not found", name));
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelledRoutineRun {
    pub run_id: String,
    pub status: String,
    pub changed: bool,
    /// Durable Work Item Runs stopped as part of the RoutineRun. The Work
    /// Items themselves remain product intent and are not auto-cancelled.
    pub cancelled_work_item_runs: usize,
    /// Sessions already launched before cancellation. Hosts may use these
    /// ids to interrupt provider processes; the durable Run is already
    /// terminal even when the original host is offline.
    pub session_ids: Vec<String>,
}

/// Idempotently terminate a portable RoutineRun and every execution episode
/// owned by its generated step items. Product Work Item lifecycle is kept
/// separate: cancellation stops automation, not the user's underlying work.
pub fn cancel_run(
    run_id: &str,
    actor: Option<&crate::projects::types::WorkItemMutationActor>,
) -> Result<CancelledRoutineRun, String> {
    use rusqlite::OptionalExtension;

    let mut connection = project_io::helpers::conn()?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|err| format!("routine cancel tx: {err}"))?;
    let run_row: Option<(String, String)> = tx
        .query_row(
            "SELECT status, scope_id FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|err| format!("routine cancel: {err}"))?;
    let Some((stored_status, scope_id)) = run_row else {
        return Err(format!("Run '{}' not found", run_id));
    };
    if matches!(stored_status.as_str(), "succeeded" | "failed" | "cancelled") {
        tx.commit()
            .map_err(|err| format!("routine cancel commit: {err}"))?;
        return Ok(CancelledRoutineRun {
            run_id: run_id.to_string(),
            status: stored_status,
            changed: false,
            cancelled_work_item_runs: 0,
            session_ids: Vec::new(),
        });
    }

    let generated_ref = format!("run://{run_id}");
    let mut statement = tx
        .prepare(
            "SELECT DISTINCT r.id, r.session_id
               FROM pm_work_item_runs r
               JOIN pm_relations relation
                 ON relation.entity_type = 'work_item'
                AND relation.entity_id = r.work_item_id
                AND relation.kind = 'generated_by'
                AND relation.target_ref = ?1
              WHERE r.status IN ('queued', 'deferred', 'dispatching', 'running', 'waiting')",
        )
        .map_err(|err| format!("routine cancel: {err}"))?;
    let owned_runs: Vec<(String, Option<String>)> = statement
        .query_map(rusqlite::params![generated_ref], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(|err| format!("routine cancel: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine cancel: {err}"))?;
    drop(statement);

    let now = chrono::Utc::now().timestamp_millis();
    let mut cancelled_work_item_runs = 0usize;
    let mut session_ids = Vec::new();
    for (work_run_id, session_id) in owned_runs {
        tx.execute(
            "UPDATE pm_dispatch_outbox
                SET status = 'cancelled', lease_token = NULL, lease_owner = NULL,
                    lease_expires_at = NULL, updated_at = ?2
              WHERE run_id = ?1 AND status IN ('pending', 'retry_wait', 'leased')",
            rusqlite::params![work_run_id, now],
        )
        .map_err(|err| format!("routine cancel dispatch: {err}"))?;
        let changed = tx
            .execute(
                "UPDATE pm_work_item_runs
                    SET status = 'cancelled', completed_at = ?2, updated_at = ?2
                  WHERE id = ?1
                    AND status IN ('queued', 'deferred', 'dispatching', 'running', 'waiting')",
                rusqlite::params![work_run_id, now],
            )
            .map_err(|err| format!("routine cancel Work Item Run: {err}"))?;
        if changed > 0 {
            cancelled_work_item_runs += 1;
            if let Some(session_id) = session_id {
                session_ids.push(session_id);
            }
        }
        tx.execute(
            "DELETE FROM pm_work_item_path_locks WHERE run_id = ?1",
            rusqlite::params![work_run_id],
        )
        .map_err(|err| format!("routine cancel path lock: {err}"))?;
    }
    session_ids.sort();
    session_ids.dedup();

    let changed = tx
        .execute(
            "UPDATE pm_routine_runs
                SET status = 'cancelled', updated_at = ?2
              WHERE id = ?1
                AND status NOT IN ('succeeded', 'failed', 'cancelled')",
            rusqlite::params![run_id, now],
        )
        .map_err(|err| format!("routine cancel: {err}"))?;
    if changed > 0 {
        let (project_slug, org_id) = match scope_id.strip_prefix("org:") {
            Some(org_id) => (None, Some(org_id)),
            None => (Some(scope_id.as_str()), None),
        };
        let seq = work_service::audit::bump_change_seq(&tx)?;
        work_service::audit::append_audit_event(
            &tx,
            &work_service::audit::AuditEventRow {
                operation: "routine.cancel",
                entity_type: "routine_run",
                entity_id: run_id,
                project_slug,
                org_id,
                actor,
                revision: 0,
                seq,
                payload: serde_json::json!({
                    "cancelledWorkItemRuns": cancelled_work_item_runs,
                    "sessionIds": session_ids,
                }),
            },
        )?;
    }
    tx.commit()
        .map_err(|err| format!("routine cancel commit: {err}"))?;
    if cancelled_work_item_runs > 0 {
        crate::projects::events::notify_work_item_dispatch_ready();
    }
    Ok(CancelledRoutineRun {
        run_id: run_id.to_string(),
        status: "cancelled".to_string(),
        changed: changed > 0,
        cancelled_work_item_runs,
        session_ids,
    })
}

/// List routine runs, newest first, optionally filtered to one scope.
/// Row-level listing for the Runs surface — per-run WorkItem projection
/// stays in [`run_status`], which the UI calls on expand.
pub fn list_runs(scope_id: Option<&str>, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let connection = project_io::helpers::conn()?;
    let mut statement = connection
        .prepare(
            "SELECT id, routine_name, routine_revision, scope_id, status,
                    root_work_item_id, created_by, created_at, updated_at
             FROM pm_routine_runs
             WHERE (?1 IS NULL OR scope_id = ?1)
             ORDER BY created_at DESC, id DESC
             LIMIT ?2",
        )
        .map_err(|err| format!("routine list_runs: {err}"))?;
    let rows = statement
        .query_map(rusqlite::params![scope_id, limit as i64], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "routineName": row.get::<_, String>(1)?,
                "routineRevision": row.get::<_, i64>(2)?,
                "scopeId": row.get::<_, String>(3)?,
                "status": row.get::<_, String>(4)?,
                "rootWorkItemId": row.get::<_, Option<String>>(5)?,
                "createdBy": row.get::<_, Option<String>>(6)?,
                "createdAt": row.get::<_, i64>(7)?,
                "updatedAt": row.get::<_, i64>(8)?,
            }))
        })
        .map_err(|err| format!("routine list_runs: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine list_runs: {err}"))?;
    Ok(rows)
}

/// Durable run-status view: the run row plus each generated WorkItem's
/// state, with the overall status recomputed by the ordered decision
/// procedure from design §11.
pub fn run_status(run_id: &str) -> Result<serde_json::Value, String> {
    let connection = project_io::helpers::conn()?;
    let (routine_name, revision, snapshot_hash, scope_id, stored_status, root_id): (
        String,
        i64,
        String,
        String,
        String,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT routine_name, routine_revision, snapshot_hash, scope_id, status,
                    root_work_item_id
             FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => format!("Run '{}' not found", run_id),
            other => format!("routine status: {other}"),
        })?;

    // Generated children: reverse lookup on the generated_by relation.
    let mut statement = connection
        .prepare(
            "SELECT entity_id FROM pm_relations
             WHERE kind = 'generated_by' AND target_ref = ?1
             ORDER BY id",
        )
        .map_err(|err| format!("routine status: {err}"))?;
    let child_ids: Vec<String> = statement
        .query_map(rusqlite::params![format!("run://{run_id}")], |row| {
            row.get(0)
        })
        .map_err(|err| format!("routine status: {err}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| format!("routine status: {err}"))?;
    drop(statement);
    drop(connection);

    let mut items = Vec::new();
    let mut portable_states = Vec::new();
    for child_id in &child_ids {
        let item = read_scoped_work_item(&scope_id, child_id)?;
        let portable = work_service::state::map_legacy_status(&item.frontmatter.status);
        portable_states.push(portable);
        items.push(serde_json::json!({
            "shortId": child_id,
            "title": item.frontmatter.title,
            "status": item.frontmatter.status,
            "portableState": portable.map(|state| state.as_str()),
        }));
    }

    let status = project_run_status(&stored_status, &portable_states, &child_ids, &scope_id)?;

    Ok(serde_json::json!({
        "apiVersion": "orgtrack/v1",
        "kind": "RoutineRun",
        "id": run_id,
        "routineName": routine_name,
        "routineRevision": revision,
        "snapshotHash": snapshot_hash,
        "scopeId": scope_id,
        "status": status,
        "rootWorkItemId": root_id,
        "workItems": items,
    }))
}

/// Ordered first-match projection (§11). Pending and terminal cancellation
/// states short-circuit to the durable run status; the remaining rules compute
/// from the generated items.
fn project_run_status(
    stored: &str,
    portable_states: &[Option<work_service::WorkItemState>],
    child_ids: &[String],
    scope_id: &str,
) -> Result<String, String> {
    use work_service::WorkItemState::*;
    if stored == "pending" || stored.starts_with("cancel") || stored == "cancelled" {
        return Ok(stored.to_string());
    }
    if portable_states.contains(&Some(Failed)) {
        return Ok("failed".into());
    }
    if !portable_states.is_empty() && portable_states.iter().all(|s| *s == Some(Completed)) {
        return Ok("succeeded".into());
    }
    let any_in_progress = portable_states.contains(&Some(InProgress));
    if any_in_progress {
        return Ok("running".into());
    }
    // Ready open work: open with all dependencies completed.
    let connection = project_io::helpers::conn()?;
    for (index, child_id) in child_ids.iter().enumerate() {
        if portable_states[index] != Some(Open) {
            continue;
        }
        let mut statement = connection
            .prepare(
                "SELECT target_ref FROM pm_relations
                 WHERE kind = 'depends_on' AND entity_type = 'work_item' AND entity_id = ?1",
            )
            .map_err(|err| format!("routine status: {err}"))?;
        let dependencies: Vec<String> = statement
            .query_map(rusqlite::params![child_id], |row| row.get(0))
            .map_err(|err| format!("routine status: {err}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|err| format!("routine status: {err}"))?;
        let all_done = dependencies.iter().all(|target| {
            target
                .strip_prefix(&format!("work://{scope_id}/"))
                .map(|dep_id| {
                    child_ids
                        .iter()
                        .position(|c| c == dep_id)
                        .map(|position| portable_states[position] == Some(Completed))
                        .unwrap_or(true)
                })
                .unwrap_or(true)
        });
        if all_done {
            return Ok("running".into());
        }
    }
    Ok("blocked".into())
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
