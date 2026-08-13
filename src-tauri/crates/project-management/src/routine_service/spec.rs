//! Portable Routine spec (`orgtrack/v1` §10, routine.schema.json).
//!
//! The spec describes WHAT a repeatable work graph is — inputs, root
//! work template, executable steps with dependencies, actor
//! role/capability requirements, activations. It deliberately cannot
//! express model, account, credential, workspace path or session
//! targets: those live in execution bindings (operator setup), which is
//! the core boundary the legacy `RoutineDefinition` violated.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutineSpecFile {
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    pub kind: String,
    pub metadata: RoutineMetadata,
    pub spec: RoutineSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutineMetadata {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoutineSpec {
    /// BTreeMap: canonicalization requires deterministic ordering.
    #[serde(default)]
    pub inputs: BTreeMap<String, InputDecl>,
    #[serde(rename = "rootWork")]
    pub root_work: RootWorkTemplate,
    pub steps: Vec<StepSpec>,
    #[serde(default)]
    pub activations: Vec<Activation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InputDecl {
    #[serde(rename = "type")]
    pub input_type: InputType,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum InputType {
    String,
    Number,
    Boolean,
    Path,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootWorkTemplate {
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StepSpec {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<ActorRequirement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instruction: Option<String>,
    /// Mapping expressions (`${steps.<id>.outputs.<name>}` /
    /// `${inputs.<name>}`) — declarative only, never code.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub inputs: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub outputs: BTreeMap<String, OutputDecl>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActorRequirement {
    pub role: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requires: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputDecl {
    #[serde(rename = "type")]
    pub output_type: OutputType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OutputType {
    #[serde(rename = "artifact")]
    Artifact,
    #[serde(rename = "artifact-list")]
    ArtifactList,
    #[serde(rename = "reference")]
    Reference,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, tag = "type")]
pub enum Activation {
    #[serde(rename = "manual")]
    Manual {
        #[serde(flatten)]
        policies: ActivationPolicies,
    },
    #[serde(rename = "schedule")]
    Schedule {
        cron: String,
        timezone: String,
        #[serde(flatten)]
        policies: ActivationPolicies,
    },
    #[serde(rename = "provider_event")]
    ProviderEvent {
        provider: String,
        #[serde(rename = "eventKind")]
        event_kind: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        filter: Option<serde_json::Value>,
        #[serde(flatten)]
        policies: ActivationPolicies,
    },
}

/// Concurrency + catch-up carried by every activation. Defaults preserve
/// the legacy `routine_fires` semantics (skip, no catch-up) — the frozen
/// no-regression requirement.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActivationPolicies {
    #[serde(
        rename = "concurrencyPolicy",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub concurrency_policy: Option<ConcurrencyPolicy>,
    #[serde(rename = "catchUp", default, skip_serializing_if = "Option::is_none")]
    pub catch_up: Option<CatchUpPolicy>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConcurrencyPolicy {
    Coalesce,
    Skip,
    Queue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CatchUpPolicy {
    None,
    FireOnce,
}

/// Structured validation failure — stable shape for the CLI error
/// envelope's details.
#[derive(Debug, Clone, Serialize)]
pub struct SpecViolation {
    pub path: String,
    pub message: String,
}

/// Validate everything the schema cannot: id shapes, graph acyclicity,
/// `needs` referencing real steps, input-mapping expressions resolving to
/// declared inputs/outputs, and schedule shape.
pub fn validate(file: &RoutineSpecFile) -> Vec<SpecViolation> {
    let mut violations = Vec::new();
    let push = |violations: &mut Vec<SpecViolation>, path: &str, message: String| {
        violations.push(SpecViolation {
            path: path.to_string(),
            message,
        });
    };

    if file.api_version != "orgtrack/v1" {
        push(
            &mut violations,
            "apiVersion",
            format!("expected orgtrack/v1, got '{}'", file.api_version),
        );
    }
    if file.kind != "Routine" {
        push(
            &mut violations,
            "kind",
            format!("expected Routine, got '{}'", file.kind),
        );
    }
    if file.metadata.name.trim().is_empty() {
        push(&mut violations, "metadata.name", "must not be empty".into());
    }
    if file.spec.steps.is_empty() {
        push(&mut violations, "spec.steps", "at least one step".into());
    }

    // Step ids: shape + uniqueness.
    let mut step_ids = HashSet::new();
    for (index, step) in file.spec.steps.iter().enumerate() {
        let path = format!("spec.steps[{index}].id");
        let valid_shape = !step.id.is_empty()
            && step
                .id
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !step.id.starts_with('-');
        if !valid_shape {
            push(
                &mut violations,
                &path,
                format!("'{}' must match ^[a-z0-9][a-z0-9-]*$", step.id),
            );
        }
        if !step_ids.insert(step.id.clone()) {
            push(
                &mut violations,
                &path,
                format!("duplicate step id '{}'", step.id),
            );
        }
    }

    // needs: known ids, no self-reference, acyclic (Kahn).
    let mut in_degree: HashMap<&str, usize> = HashMap::new();
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for step in &file.spec.steps {
        in_degree.entry(step.id.as_str()).or_insert(0);
        for need in &step.needs {
            let path = format!("spec.steps[{}].needs", step.id);
            if need == &step.id {
                push(&mut violations, &path, "step cannot need itself".into());
                continue;
            }
            if !step_ids.contains(need) {
                push(&mut violations, &path, format!("unknown step '{need}'"));
                continue;
            }
            *in_degree.entry(step.id.as_str()).or_insert(0) += 1;
            dependents
                .entry(need.as_str())
                .or_default()
                .push(step.id.as_str());
        }
    }
    let mut queue: Vec<&str> = in_degree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| *id)
        .collect();
    let mut visited = 0usize;
    while let Some(id) = queue.pop() {
        visited += 1;
        if let Some(children) = dependents.get(id) {
            for child in children {
                let degree = in_degree.get_mut(child).expect("child tracked");
                *degree -= 1;
                if *degree == 0 {
                    queue.push(child);
                }
            }
        }
    }
    if visited != in_degree.len() {
        push(
            &mut violations,
            "spec.steps",
            "dependency graph contains a cycle".into(),
        );
    }

    // Input mapping expressions: ${inputs.x} or ${steps.<id>.outputs.<name>}
    // where the referenced step is a declared dependency with that output.
    for step in &file.spec.steps {
        for (input_name, expression) in &step.inputs {
            let path = format!("spec.steps[{}].inputs.{}", step.id, input_name);
            let Some(inner) = expression
                .strip_prefix("${")
                .and_then(|rest| rest.strip_suffix('}'))
            else {
                push(
                    &mut violations,
                    &path,
                    format!("'{expression}' is not a ${{...}} mapping expression"),
                );
                continue;
            };
            if let Some(name) = inner.strip_prefix("inputs.") {
                if !file.spec.inputs.contains_key(name) {
                    push(
                        &mut violations,
                        &path,
                        format!("unknown routine input '{name}'"),
                    );
                }
                continue;
            }
            if let Some(rest) = inner.strip_prefix("steps.") {
                let parts: Vec<&str> = rest.split('.').collect();
                if parts.len() == 3 && parts[1] == "outputs" {
                    let (source_id, output_name) = (parts[0], parts[2]);
                    let source = file.spec.steps.iter().find(|s| s.id == source_id);
                    match source {
                        None => push(
                            &mut violations,
                            &path,
                            format!("unknown source step '{source_id}'"),
                        ),
                        Some(source_step) => {
                            if !step.needs.iter().any(|need| need == source_id) {
                                push(
                                    &mut violations,
                                    &path,
                                    format!("step must declare '{source_id}' in needs to consume its outputs"),
                                );
                            }
                            if !source_step.outputs.contains_key(output_name) {
                                push(
                                    &mut violations,
                                    &path,
                                    format!(
                                        "step '{source_id}' declares no output '{output_name}'"
                                    ),
                                );
                            }
                        }
                    }
                    continue;
                }
                push(
                    &mut violations,
                    &path,
                    format!("'{inner}' must be steps.<id>.outputs.<name>"),
                );
                continue;
            }
            push(
                &mut violations,
                &path,
                format!("'{inner}' must reference inputs.* or steps.*.outputs.*"),
            );
        }
    }

    // Activations.
    for (index, activation) in file.spec.activations.iter().enumerate() {
        if let Activation::Schedule { cron, timezone, .. } = activation {
            let path = format!("spec.activations[{index}]");
            if cron.split_whitespace().count() != 5 {
                push(
                    &mut violations,
                    &path,
                    format!("cron '{cron}' must have 5 fields"),
                );
            }
            if timezone.trim().is_empty() {
                push(&mut violations, &path, "timezone is required".into());
            } else if timezone.parse::<chrono_tz::Tz>().is_err() {
                push(
                    &mut violations,
                    &path,
                    format!("timezone '{timezone}' must be a valid IANA timezone"),
                );
            }
        }
    }

    violations
}

/// Canonical JSON used for the immutable snapshot hash: serde with
/// BTreeMaps gives deterministic key order; whitespace-free encoding.
pub fn canonicalize(file: &RoutineSpecFile) -> Result<String, String> {
    serde_json::to_string(file).map_err(|err| format!("canonicalize routine: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> RoutineSpecFile {
        let raw = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json"),
        )
        .expect("frozen fixture readable");
        serde_json::from_str(&raw).expect("frozen fixture parses")
    }

    #[test]
    fn frozen_fixture_is_valid() {
        let file = fixture();
        let violations = validate(&file);
        assert!(violations.is_empty(), "{violations:?}");
    }

    #[test]
    fn cycle_is_rejected() {
        let mut file = fixture();
        file.spec.steps[0].needs = vec!["archive-and-notify".to_string()];
        let violations = validate(&file);
        assert!(
            violations.iter().any(|v| v.message.contains("cycle")),
            "{violations:?}"
        );
    }

    #[test]
    fn unknown_need_is_rejected() {
        let mut file = fixture();
        file.spec.steps[1].needs = vec!["missing-step".to_string()];
        let violations = validate(&file);
        assert!(
            violations
                .iter()
                .any(|v| v.message.contains("unknown step")),
            "{violations:?}"
        );
    }

    #[test]
    fn consuming_outputs_without_needs_is_rejected() {
        let mut file = fixture();
        file.spec.steps[1].needs = vec![];
        let violations = validate(&file);
        assert!(
            violations
                .iter()
                .any(|v| v.message.contains("must declare")),
            "{violations:?}"
        );
    }

    #[test]
    fn arbitrary_expression_is_rejected() {
        let mut file = fixture();
        file.spec.steps[1]
            .inputs
            .insert("evil".into(), "$(rm -rf /)".into());
        let violations = validate(&file);
        assert!(
            violations
                .iter()
                .any(|v| v.message.contains("mapping expression")),
            "{violations:?}"
        );
    }

    #[test]
    fn canonicalization_is_deterministic() {
        let a = canonicalize(&fixture()).unwrap();
        let b = canonicalize(&fixture()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn model_account_workspace_fields_cannot_parse() {
        // The frozen boundary: runtime resources are not expressible.
        let mut raw: serde_json::Value = serde_json::to_value(fixture()).unwrap();
        raw["spec"]["model"] = serde_json::json!("gpt-x");
        let parsed: Result<RoutineSpecFile, _> = serde_json::from_value(raw);
        assert!(parsed.is_err(), "deny_unknown_fields must reject model");
    }
}
