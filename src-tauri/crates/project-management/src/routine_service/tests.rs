//! Integration tests for the routine application service (Phase 4):
//! apply idempotency, revision bumps, and spec-boundary rejection.

use super::*;
use test_helpers::test_env;

fn fixture() -> spec::RoutineSpecFile {
    let raw = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json"),
    )
    .expect("frozen fixture readable");
    serde_json::from_str(&raw).expect("frozen fixture parses")
}

#[test]
fn apply_is_idempotent_for_identical_canonical_bodies() {
    let _sandbox = test_env::sandbox();
    let file = fixture();

    let first = apply(&file).expect("first apply");
    assert_eq!(first.revision, 1);
    assert!(first.changed);

    let second = apply(&file).expect("second apply");
    assert_eq!(second.revision, 1, "same canonical body keeps the revision");
    assert!(!second.changed);
    assert_eq!(first.spec_hash, second.spec_hash);
}

#[test]
fn apply_bumps_revision_when_the_body_changes() {
    let _sandbox = test_env::sandbox();
    let mut file = fixture();
    let first = apply(&file).expect("first apply");

    file.spec.root_work.title = "改标题：{{ inputs.requirement_id }}".to_string();
    let second = apply(&file).expect("second apply");
    assert_eq!(second.revision, first.revision + 1);
    assert!(second.changed);
    assert_ne!(first.spec_hash, second.spec_hash);
}

#[test]
fn invoke_materializes_the_work_graph_with_durable_edges() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None).expect("invoke");

    // Root carries the substituted template.
    let root = crate::projects::io::read_work_item("demo", &run.root_short_id).expect("root");
    assert!(root.frontmatter.title.contains("REQ-001"), "{}", root.frontmatter.title);

    // One generated child per step, parented to the root.
    assert_eq!(run.steps.len(), 3);
    for (_, child_id) in &run.steps {
        let child = crate::projects::io::read_work_item("demo", child_id).expect("child");
        assert_eq!(child.frontmatter.parent.as_deref(), Some(run.root_short_id.as_str()));
    }

    // Dependency edges are durable relations: review-impact depends_on
    // collect-deliverables; every child is generated_by the run.
    let review_child = &run.steps.iter().find(|(id, _)| id == "review-impact").unwrap().1;
    let collect_child = &run.steps.iter().find(|(id, _)| id == "collect-deliverables").unwrap().1;
    let relations = crate::work_service::list_work_item_relations(review_child).expect("relations");
    let has_dep = relations.iter().any(|r| {
        r["kind"] == "depends_on"
            && r["targetRef"] == format!("work://demo/{}", collect_child)
    });
    assert!(has_dep, "{relations:?}");
    let has_run = relations
        .iter()
        .any(|r| r["kind"] == "generated_by" && r["targetRef"] == format!("run://{}", run.run_id));
    assert!(has_run, "{relations:?}");

    // The run row is durable with the immutable snapshot pinned.
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let (status, revision, root_id): (String, i64, String) = connection
        .query_row(
            "SELECT status, routine_revision, root_work_item_id FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run.run_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("run row");
    assert_eq!(status, "running");
    assert_eq!(revision, 1);
    assert_eq!(root_id, run.root_short_id);
}

#[test]
fn invoke_validates_inputs_against_the_snapshot_contract() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let missing = invoke(&file.metadata.name, "demo", &Default::default(), None)
        .expect_err("required input missing");
    assert!(missing.starts_with(error::INPUTS_INVALID), "{missing}");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    inputs.insert("nonsense".to_string(), "x".to_string());
    let unknown =
        invoke(&file.metadata.name, "demo", &inputs, None).expect_err("unknown input rejected");
    assert!(unknown.starts_with(error::INPUTS_INVALID), "{unknown}");
}

#[test]
fn legacy_conversion_expresses_create_and_direct_modes_and_skips_updates() {
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
        RoutineOutputPolicy, RoutineResourceSelection, RoutineRunTarget, RoutineRunTemplate,
        RoutineTrigger, RoutineWorkspaceTarget,
    };
    let _sandbox = test_env::sandbox();

    let legacy = |mode: RoutineOutputMode, name: &str| RoutineDefinition {
        id: format!("legacy-{name}"),
        name: name.to_string(),
        description: "legacy description".to_string(),
        enabled: true,
        trigger: RoutineTrigger::Cron {
            cron: "0 9 * * 1-5".to_string(),
        },
        run_template: RoutineRunTemplate {
            prompt: "Do the thing".to_string(),
            target: RoutineRunTarget::AgentDefinition {
                agent_definition_id: Some("builtin:sde".to_string()),
            },
            resources: RoutineResourceSelection {
                key_source: None,
                account_id: Some("acct-1".to_string()),
                model: Some("some-model".to_string()),
                native_harness_type: None,
            },
            workspace: RoutineWorkspaceTarget::None,
            mode: None,
            name: None,
        },
        output_policy: RoutineOutputPolicy {
            mode,
            concurrency_policy: RoutineConcurrencyPolicy::QueueIfActive,
            catch_up_policy: RoutineCatchUpPolicy::RunOnce,
            ..RoutineOutputPolicy::default()
        },
        last_evaluated_at: None,
        next_fire_at: None,
        created_at: String::new(),
        updated_at: String::new(),
    };

    // Expressible: single-step portable routine with binding warnings.
    let (file, warnings) =
        convert::convert_definition(&legacy(RoutineOutputMode::CreateWorkItem, "Daily Sync"))
            .expect("convertible");
    assert!(spec::validate(&file).is_empty());
    assert_eq!(file.spec.steps.len(), 1);
    assert!(warnings.iter().any(|w| w.contains("execution binding")));
    assert!(warnings.iter().any(|w| w.contains("agent target")));
    let applied = apply(&file).expect("apply converted");
    assert_eq!(applied.revision, 1);

    // Not expressible yet: UpdateExistingWorkItem.
    let mut updater = legacy(RoutineOutputMode::UpdateExistingWorkItem, "Refresher");
    updater.output_policy.update_work_item_short_id = Some("AAA-0009".to_string());
    let reason = convert::convert_definition(&updater).expect_err("must skip");
    assert!(reason.contains("Phase 5"), "{reason}");
}

#[test]
fn apply_rejects_invalid_specs_with_structured_violations() {
    let _sandbox = test_env::sandbox();
    let mut file = fixture();
    file.spec.steps[0].needs = vec!["archive-and-notify".to_string()];

    let err = apply(&file).expect_err("cycle must be rejected");
    assert!(
        err.starts_with(error::SPEC_INVALID),
        "typed sentinel expected: {err}"
    );
    assert!(err.contains("cycle"), "violation payload rides along: {err}");
}
