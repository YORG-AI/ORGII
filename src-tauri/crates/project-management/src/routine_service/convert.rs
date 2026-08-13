//! One-way conversion of legacy `RoutineDefinition` rows into portable
//! Routine specs (Phase 4 migration).
//!
//! The conversion is additive: portable definitions land in
//! `pm_routines` while legacy rows stay untouched until the Phase 5
//! runtime unification deletes the legacy scheduler — running both
//! stores side by side cannot double-fire because the portable runtime's
//! scheduler does not exist yet.
//!
//! What is expressible and what is not:
//! - `CreateWorkItem` and `DirectSession` routines become single-step
//!   portable routines (the prompt is the step instruction). The
//!   model/account/workspace/harness resources on the legacy template
//!   are NOT portable by design — they are reported as required
//!   execution bindings for the operator to configure.
//! - `UpdateExistingWorkItem` routines target an existing work item;
//!   the portable equivalent (`routine run --root-work`) is not wired
//!   yet, so those definitions are reported as `skipped` and keep
//!   running on the legacy path until Phase 5.
//! - `OneTime` triggers have no portable activation (schedule requires
//!   cron); the portable spec gets a manual activation and the report
//!   notes the dropped one-shot timestamp.

use serde::Serialize;
use std::collections::BTreeMap;

use crate::projects::types::{
    RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
    RoutineRunTarget, RoutineTrigger, RoutineWorkspaceTarget,
};

use super::spec::{
    Activation, ActivationPolicies, CatchUpPolicy, ConcurrencyPolicy, RootWorkTemplate,
    RoutineMetadata, RoutineSpec, RoutineSpecFile, StepSpec,
};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionReport {
    /// name -> new portable revision.
    pub converted: Vec<ConvertedRoutine>,
    /// Definitions the portable model cannot express yet.
    pub skipped: Vec<SkippedRoutine>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertedRoutine {
    pub legacy_id: String,
    pub name: String,
    pub revision: i64,
    /// Non-portable knowledge the operator must re-express as execution
    /// bindings (model/account/harness/workspace) or accept as dropped
    /// (one-shot trigger timestamps).
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRoutine {
    pub legacy_id: String,
    pub name: String,
    pub reason: String,
}

fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "legacy-routine".to_string()
    } else {
        trimmed
    }
}

fn map_policies(definition: &RoutineDefinition) -> (ActivationPolicies, Vec<String>) {
    let mut warnings = Vec::new();
    let concurrency = match definition.output_policy.concurrency_policy {
        RoutineConcurrencyPolicy::CoalesceIfActive => ConcurrencyPolicy::Coalesce,
        RoutineConcurrencyPolicy::SkipIfActive => ConcurrencyPolicy::Skip,
        RoutineConcurrencyPolicy::QueueIfActive => ConcurrencyPolicy::Queue,
        RoutineConcurrencyPolicy::AlwaysCreate => {
            warnings.push(
                "concurrency 'always_create' has no portable equivalent; mapped to 'queue'"
                    .to_string(),
            );
            ConcurrencyPolicy::Queue
        }
    };
    let catch_up = match definition.output_policy.catch_up_policy {
        RoutineCatchUpPolicy::SkipMissed => CatchUpPolicy::None,
        RoutineCatchUpPolicy::RunOnce => CatchUpPolicy::FireOnce,
        RoutineCatchUpPolicy::RunAllLimited => {
            warnings.push(format!(
                "catch-up 'run_all_limited' (max {}) has no portable equivalent; mapped to 'fire_once'",
                definition.output_policy.max_catch_up_runs
            ));
            CatchUpPolicy::FireOnce
        }
    };
    (
        ActivationPolicies {
            concurrency_policy: Some(concurrency),
            catch_up: Some(catch_up),
        },
        warnings,
    )
}

/// Convert one legacy definition. `Ok(Err(reason))` means "valid input,
/// not expressible portably".
pub fn convert_definition(
    definition: &RoutineDefinition,
) -> Result<(RoutineSpecFile, Vec<String>), String> {
    if definition.output_policy.mode == RoutineOutputMode::UpdateExistingWorkItem {
        return Err(format!(
            "targets existing work item {:?} — portable --root-work runs land in Phase 5",
            definition.output_policy.update_work_item_short_id
        ));
    }

    let mut warnings = Vec::new();
    let (policies, policy_warnings) = map_policies(definition);
    warnings.extend(policy_warnings);

    // Resources are the boundary the portable model enforces.
    let resources = &definition.run_template.resources;
    if resources.model.is_some()
        || resources.account_id.is_some()
        || resources.key_source.is_some()
        || resources.native_harness_type.is_some()
    {
        warnings.push(
            "model/account/harness selection dropped from the portable spec; re-express as an execution binding"
                .to_string(),
        );
    }
    if !matches!(
        definition.run_template.workspace,
        RoutineWorkspaceTarget::None
    ) {
        warnings.push(
            "workspace/worktree target dropped from the portable spec; re-express as an execution binding"
                .to_string(),
        );
    }
    match &definition.run_template.target {
        RoutineRunTarget::AgentDefinition {
            agent_definition_id: Some(id),
        } => warnings.push(format!(
            "agent target '{id}' dropped; bind role 'worker' to it in operator setup"
        )),
        RoutineRunTarget::AgentOrg { agent_org_id } => warnings.push(format!(
            "agent org target '{agent_org_id}' dropped; bind role 'worker' to it in operator setup"
        )),
        _ => {}
    }

    let activation = match &definition.trigger {
        RoutineTrigger::Cron { cron, timezone } => Activation::Schedule {
            cron: cron.clone(),
            timezone: timezone.clone(),
            policies,
        },
        RoutineTrigger::OneTime { at } => {
            warnings.push(format!(
                "one-shot trigger at '{at}' has no portable activation; converted to manual"
            ));
            Activation::Manual { policies }
        }
    };

    let root_title = definition
        .output_policy
        .create_work_item_title
        .clone()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| definition.name.clone());
    let root_body = definition
        .output_policy
        .create_work_item_body
        .clone()
        .filter(|body| !body.trim().is_empty())
        .unwrap_or_else(|| definition.description.clone());

    let file = RoutineSpecFile {
        api_version: "orgtrack/v1".to_string(),
        kind: "Routine".to_string(),
        metadata: RoutineMetadata {
            id: format!("routine_{}", slugify(&definition.name)),
            name: slugify(&definition.name),
            revision: None,
        },
        spec: RoutineSpec {
            inputs: BTreeMap::new(),
            root_work: RootWorkTemplate {
                title: root_title,
                body: Some(root_body),
                priority: None,
                labels: vec![],
            },
            steps: vec![StepSpec {
                id: "execute".to_string(),
                title: definition
                    .run_template
                    .name
                    .clone()
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| definition.name.clone()),
                needs: vec![],
                actor: Some(super::spec::ActorRequirement {
                    role: "worker".to_string(),
                    requires: vec![],
                }),
                instruction: Some(definition.run_template.prompt.clone()),
                inputs: BTreeMap::new(),
                outputs: BTreeMap::new(),
            }],
            activations: vec![activation],
        },
    };
    Ok((file, warnings))
}

/// Convert every legacy definition currently in the store, applying the
/// expressible ones into `pm_routines` and reporting the rest.
///
/// With `disable_converted_legacy`, successfully converted legacy rows
/// that carry a scope binding are disabled in the same pass so the legacy
/// scheduler can never fire them again — the portable scheduler is their
/// only driver from then on (no double-fire window). Conversions without
/// a scope binding keep their legacy row enabled: the portable pass
/// cannot fire them, so disabling would silently kill the routine.
/// Skipped definitions stay enabled on the legacy path until they become
/// expressible.
pub fn convert_all(disable_converted_legacy: bool) -> Result<ConversionReport, String> {
    let definitions = crate::projects::io::list_routines()?;
    let mut report = ConversionReport::default();
    for definition in &definitions {
        match convert_definition(definition) {
            Ok((file, warnings)) => {
                let applied = super::apply(&file)?;
                // Host-local scope binding: scheduled invokes need a
                // target project. CreateWorkItem routines carried it on
                // the legacy policy; DirectSession ones did not — those
                // stay manual-only until the operator binds a scope.
                let scope_bound = if let Some(scope) = definition
                    .output_policy
                    .create_work_item_project_slug
                    .as_deref()
                {
                    super::set_default_scope(&applied.name, scope)?;
                    true
                } else {
                    false
                };
                // Disabling the legacy row without a scope binding would
                // leave the routine with no working driver: the portable
                // pass suppresses every scheduled fire as no_scope_binding.
                if disable_converted_legacy && definition.enabled && scope_bound {
                    crate::projects::io::disable_routine(&definition.id)?;
                }
                report.converted.push(ConvertedRoutine {
                    legacy_id: definition.id.clone(),
                    name: applied.name,
                    revision: applied.revision,
                    warnings,
                });
            }
            Err(reason) => report.skipped.push(SkippedRoutine {
                legacy_id: definition.id.clone(),
                name: definition.name.clone(),
                reason,
            }),
        }
    }
    Ok(report)
}
