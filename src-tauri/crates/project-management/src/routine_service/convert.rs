//! One-way conversion of legacy `RoutineDefinition` rows into portable
//! Routine specs plus host-local execution targets.
//!
//! The conversion is additive: portable definitions land in
//! `pm_routines` as a rebuildable execution projection; the editable
//! `routine_definitions` row remains the single definition source.
//!
//! What is expressible and what is not:
//! - `CreateWorkItem` and `DirectSession` routines become single-step
//!   portable routines (the prompt is the step instruction). The
//!   model/account/workspace/harness resources on the legacy template
//!   are NOT portable by design — they are reported as required
//!   execution bindings for the operator to configure.
//! - `UpdateExistingWorkItem` routines retain their target as a host-local
//!   `RoutineInvocationTarget`; the portable spec itself stays free of
//!   project/work-item identity.
//! - `OneTime` triggers retain their RFC 3339 timestamp as a portable
//!   one-time activation.

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
use super::RoutineInvocationTarget;

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
    /// bindings (model/account/harness/workspace).
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedRoutine {
    pub legacy_id: String,
    pub name: String,
    pub reason: String,
}

pub fn convert_and_handover(
    definition: &RoutineDefinition,
    _disable_legacy: bool,
) -> Result<ConvertedRoutine, String> {
    super::legacy_bridge::sync_definition(definition)
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
    let warnings = Vec::new();
    let concurrency = match definition.output_policy.concurrency_policy {
        RoutineConcurrencyPolicy::CoalesceIfActive => ConcurrencyPolicy::Coalesce,
        RoutineConcurrencyPolicy::SkipIfActive => ConcurrencyPolicy::Skip,
        RoutineConcurrencyPolicy::QueueIfActive => ConcurrencyPolicy::Queue,
        RoutineConcurrencyPolicy::AlwaysCreate => ConcurrencyPolicy::Always,
    };
    let catch_up = match definition.output_policy.catch_up_policy {
        RoutineCatchUpPolicy::SkipMissed => CatchUpPolicy::None,
        RoutineCatchUpPolicy::RunOnce => CatchUpPolicy::FireOnce,
        RoutineCatchUpPolicy::RunAllLimited => CatchUpPolicy::RunAllLimited,
    };
    (
        ActivationPolicies {
            concurrency_policy: Some(concurrency),
            catch_up: Some(catch_up),
            max_catch_up_runs: (definition.output_policy.catch_up_policy
                == RoutineCatchUpPolicy::RunAllLimited)
                .then_some(definition.output_policy.max_catch_up_runs.max(1)),
        },
        warnings,
    )
}

/// Convert one legacy definition. `Ok(Err(reason))` means "valid input,
/// not expressible portably".
pub fn convert_definition(
    definition: &RoutineDefinition,
) -> Result<(RoutineSpecFile, Vec<String>), String> {
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
        Some(RoutineTrigger::Cron { cron, timezone }) => Activation::Schedule {
            cron: cron.clone(),
            timezone: timezone.clone(),
            policies: policies.clone(),
        },
        Some(RoutineTrigger::OneTime { at }) => Activation::OneTime {
            at: at.clone(),
            policies: policies.clone(),
        },
        None => Activation::Manual {
            policies: policies.clone(),
        },
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
            id: definition.id.clone(),
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
            activations: resolve_activations(definition, activation, &policies),
        },
    };
    Ok((file, warnings))
}

/// Resolve the legacy output policy into deployment-local invocation state.
/// This identity never enters the portable spec or its immutable hash.
pub fn invocation_target(
    definition: &RoutineDefinition,
) -> Result<RoutineInvocationTarget, String> {
    match definition.output_policy.mode {
        RoutineOutputMode::UpdateExistingWorkItem => {
            let root_work_item_id = definition
                .output_policy
                .update_work_item_short_id
                .as_deref()
                .filter(|id| !id.trim().is_empty())
                .ok_or_else(|| {
                    "UpdateExistingWorkItem routine is missing update_work_item_short_id"
                        .to_string()
                })?
                .to_string();
            Ok(
                if let Some(project_slug) = definition
                    .output_policy
                    .update_work_item_project_slug
                    .as_deref()
                    .filter(|slug| !slug.trim().is_empty())
                {
                    RoutineInvocationTarget::ExistingProjectWork {
                        project_slug: project_slug.to_string(),
                        root_work_item_id,
                    }
                } else {
                    RoutineInvocationTarget::ExistingStandaloneWork {
                        org_id: crate::projects::types::PERSONAL_ORG_ID.to_string(),
                        root_work_item_id,
                    }
                },
            )
        }
        RoutineOutputMode::CreateWorkItem => Ok(definition
            .output_policy
            .create_work_item_project_slug
            .as_deref()
            .filter(|slug| !slug.trim().is_empty())
            .map(RoutineInvocationTarget::project)
            .unwrap_or_else(|| RoutineInvocationTarget::standalone(None))),
        RoutineOutputMode::DirectSession => Ok(RoutineInvocationTarget::standalone(None)),
    }
}

/// Convert every legacy definition currently in the store, applying the
/// expressible ones into `pm_routines` and reporting the rest.
///
/// The source row stays editable while only the portable projection executes,
/// so reconciliation cannot create a second firing path.
pub fn convert_all(_disable_converted_legacy: bool) -> Result<ConversionReport, String> {
    let definitions = crate::projects::io::list_routines()?;
    let mut report = ConversionReport::default();
    for definition in &definitions {
        match super::legacy_bridge::sync_definition(definition) {
            Ok(converted) => report.converted.push(converted),
            Err(reason) => report.skipped.push(SkippedRoutine {
                legacy_id: definition.id.clone(),
                name: definition.name.clone(),
                reason,
            }),
        }
    }
    Ok(report)
}

fn activation_policies_mut(activation: &mut Activation) -> &mut super::spec::ActivationPolicies {
    match activation {
        Activation::Manual { policies }
        | Activation::Schedule { policies, .. }
        | Activation::OneTime { policies, .. }
        | Activation::ProviderEvent { policies, .. } => policies,
    }
}

/// The wizard's explicit activation list wins over the single legacy
/// trigger; entries without their own policies inherit the routine's
/// converted concurrency and catch-up intent so a multi-activation
/// routine gates the same way the single-trigger one did.
fn resolve_activations(
    definition: &RoutineDefinition,
    converted_trigger: Activation,
    default_policies: &super::spec::ActivationPolicies,
) -> Vec<Activation> {
    if definition.activations.is_empty() {
        return vec![converted_trigger];
    }
    definition
        .activations
        .iter()
        .cloned()
        .map(|mut entry| {
            let policies = activation_policies_mut(&mut entry);
            if policies.concurrency_policy.is_none()
                && policies.catch_up.is_none()
                && policies.max_catch_up_runs.is_none()
            {
                *policies = default_policies.clone();
            }
            entry
        })
        .collect()
}
