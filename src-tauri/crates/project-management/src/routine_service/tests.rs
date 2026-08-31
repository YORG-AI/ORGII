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
fn schedule_activation_rejects_an_invalid_timezone() {
    let mut file = fixture();
    let activation = file
        .spec
        .activations
        .iter_mut()
        .find_map(|activation| match activation {
            spec::Activation::Schedule { timezone, .. } => Some(timezone),
            _ => None,
        })
        .expect("fixture has a schedule activation");
    *activation = "Mars/Olympus".to_string();

    let violations = spec::validate(&file);
    assert!(
        violations
            .iter()
            .any(|violation| violation.message.contains("valid IANA timezone")),
        "{violations:?}"
    );
}

#[test]
fn invoke_materializes_the_work_graph_with_durable_edges() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke");

    // Root carries the substituted template.
    let root = crate::projects::io::read_work_item("demo", &run.root_short_id).expect("root");
    assert!(
        root.frontmatter.title.contains("REQ-001"),
        "{}",
        root.frontmatter.title
    );

    // One generated child per step, parented to the root.
    assert_eq!(run.steps.len(), 3);
    for (_, child_id) in &run.steps {
        let child = crate::projects::io::read_work_item("demo", child_id).expect("child");
        assert_eq!(
            child.frontmatter.parent.as_deref(),
            Some(run.root_short_id.as_str())
        );
    }

    // Dependency edges are durable relations: review-impact depends_on
    // collect-deliverables; every child is generated_by the run.
    let review_child = &run
        .steps
        .iter()
        .find(|(id, _)| id == "review-impact")
        .unwrap()
        .1;
    let collect_child = &run
        .steps
        .iter()
        .find(|(id, _)| id == "collect-deliverables")
        .unwrap()
        .1;
    let relations = crate::work_service::list_work_item_relations(review_child).expect("relations");
    let has_dep = relations.iter().any(|r| {
        r["kind"] == "depends_on" && r["targetRef"] == format!("work://demo/{}", collect_child)
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

    let missing = invoke(&file.metadata.name, "demo", &Default::default(), None, None)
        .expect_err("required input missing");
    assert!(missing.starts_with(error::INPUTS_INVALID), "{missing}");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    inputs.insert("nonsense".to_string(), "x".to_string());
    let unknown = invoke(&file.metadata.name, "demo", &inputs, None, None)
        .expect_err("unknown input rejected");
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
            timezone: "America/Vancouver".to_string(),
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
        last_fire_at: None,
        last_fire_status: None,
        last_fire_error: None,
        last_fire_session_id: None,
        last_fire_work_item_id: None,
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

fn set_child_status(scope: &str, short_id: &str, status: &str) {
    let item = crate::projects::io::read_work_item(scope, short_id).expect("child readable");
    let mut frontmatter = item.frontmatter.clone();
    frontmatter.status = status.to_string();
    crate::projects::io::write_work_item(scope, short_id, &frontmatter, &item.body)
        .expect("child status seeded");
}

fn stored_run_status(run_id: &str) -> String {
    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .query_row(
            "SELECT status FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| row.get(0),
        )
        .expect("run row")
}

#[test]
fn has_active_run_terminalizes_a_finished_run_and_unsuppresses() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke");

    assert!(has_active_run(&file.metadata.name).expect("active while children open"));
    assert_eq!(stored_run_status(&run.run_id), "running");

    for (_, child_id) in &run.steps {
        set_child_status("demo", child_id, "done");
    }

    assert!(!has_active_run(&file.metadata.name).expect("inactive once children done"));
    assert_eq!(stored_run_status(&run.run_id), "succeeded");

    let second = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("re-invoke");
    assert_ne!(second.run_id, run.run_id);
}

#[test]
fn has_active_run_writes_back_failed_and_cancelled_outcomes() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());

    let failed_run = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke");
    for (index, (_, child_id)) in failed_run.steps.iter().enumerate() {
        let status = if index == 0 { "failed" } else { "done" };
        set_child_status("demo", child_id, status);
    }
    assert!(!has_active_run(&file.metadata.name).expect("failed run is not active"));
    assert_eq!(stored_run_status(&failed_run.run_id), "failed");

    let cancelled_run =
        invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke again");
    for (index, (_, child_id)) in cancelled_run.steps.iter().enumerate() {
        let status = if index == 0 { "cancelled" } else { "done" };
        set_child_status("demo", child_id, status);
    }
    assert!(!has_active_run(&file.metadata.name).expect("cancelled run is not active"));
    assert_eq!(stored_run_status(&cancelled_run.run_id), "cancelled");
}

#[test]
fn convert_all_keeps_the_legacy_row_enabled_without_a_scope_binding() {
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
        RoutineOutputPolicy, RoutineResourceSelection, RoutineRunTarget, RoutineRunTemplate,
        RoutineTrigger, RoutineWorkspaceTarget,
    };
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");

    let legacy = |name: &str, slug: Option<&str>| RoutineDefinition {
        id: format!("legacy-{name}"),
        name: name.to_string(),
        description: "legacy description".to_string(),
        enabled: true,
        trigger: RoutineTrigger::Cron {
            cron: "0 9 * * 1-5".to_string(),
            timezone: "UTC".to_string(),
        },
        run_template: RoutineRunTemplate {
            prompt: "Do the thing".to_string(),
            target: RoutineRunTarget::AgentDefinition {
                agent_definition_id: Some("builtin:sde".to_string()),
            },
            resources: RoutineResourceSelection {
                key_source: None,
                account_id: None,
                model: None,
                native_harness_type: None,
            },
            workspace: RoutineWorkspaceTarget::None,
            mode: None,
            name: None,
        },
        output_policy: RoutineOutputPolicy {
            mode: RoutineOutputMode::CreateWorkItem,
            concurrency_policy: RoutineConcurrencyPolicy::QueueIfActive,
            catch_up_policy: RoutineCatchUpPolicy::RunOnce,
            create_work_item_project_slug: slug.map(str::to_string),
            ..RoutineOutputPolicy::default()
        },
        last_evaluated_at: None,
        next_fire_at: None,
        last_fire_at: None,
        last_fire_status: None,
        last_fire_error: None,
        last_fire_session_id: None,
        last_fire_work_item_id: None,
        created_at: String::new(),
        updated_at: String::new(),
    };

    let unbound = crate::projects::io::upsert_routine(legacy("Unbound", None)).expect("seed");
    let bound = crate::projects::io::upsert_routine(legacy("Bound", Some("demo"))).expect("seed");

    let report = convert::convert_all(true).expect("convert");
    assert_eq!(report.converted.len(), 2, "{report:?}");

    let unbound_after = crate::projects::io::read_routine(&unbound.id).expect("read");
    assert!(
        unbound_after.enabled,
        "scope-less conversion must keep its legacy driver"
    );
    let bound_after = crate::projects::io::read_routine(&bound.id).expect("read");
    assert!(
        !bound_after.enabled,
        "scope-bound conversion hands over to the portable pass"
    );
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
    assert!(
        err.contains("cycle"),
        "violation payload rides along: {err}"
    );
}

#[test]
fn invoke_with_key_replays_instead_of_reinvoking() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());

    let first =
        invoke(&file.metadata.name, "demo", &inputs, None, Some("fire-1")).expect("first invoke");
    let second =
        invoke(&file.metadata.name, "demo", &inputs, None, Some("fire-1")).expect("replay");
    assert_eq!(first.run_id, second.run_id);
    assert_eq!(first.root_short_id, second.root_short_id);

    let connection = crate::projects::io::helpers::conn().expect("conn");
    let runs: i64 = connection
        .query_row("SELECT COUNT(*) FROM pm_routine_runs", [], |row| row.get(0))
        .expect("count");
    assert_eq!(runs, 1, "replay must not mint a second graph");

    let mut other_inputs = inputs.clone();
    other_inputs.insert("requirement_id".to_string(), "REQ-002".to_string());
    let conflict = invoke(
        &file.metadata.name,
        "demo",
        &other_inputs,
        None,
        Some("fire-1"),
    )
    .expect_err("different request on the same key");
    assert!(
        conflict.starts_with(crate::work_service::error::IDEMPOTENCY_CONFLICT),
        "{conflict}"
    );
}

/// A same-prefix `short_id` owned by another org used to make a mid-graph
/// node collide. It no longer does: `allocate_short_id_in_tx` walks past
/// every globally taken `workitems.id` before handing one out (see
/// `projects::io::work_items::crud_tests::allocate_short_id_skips_same_prefix_across_orgs`),
/// so the invoke succeeds and simply steps over the taken number. Pinned
/// here at the service level because this is the exact scenario that used
/// to be an `ALREADY_EXISTS` failure.
#[test]
fn invoke_steps_over_a_cross_org_short_id_instead_of_colliding() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute(
            "INSERT OR IGNORE INTO project_orgs (id, name, slug, org_key, created_at, updated_at)
             VALUES ('other-org', 'Other', 'other', 'other-key', 0, 0)",
            [],
        )
        .expect("seed org");
    connection
        .execute(
            "INSERT INTO workitems (id, org_id, short_id, title, status, created_at, updated_at)
             VALUES ('AAA-0002', 'other-org', 'AAA-0002', 'cross-org landmine', 'backlog', 0, 0)",
            [],
        )
        .expect("seed landmine row");
    drop(connection);

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None, Some("fire-x")).expect("invoke");

    assert_eq!(run.root_short_id, "AAA-0001");
    let allocated: Vec<&str> = std::iter::once(run.root_short_id.as_str())
        .chain(run.steps.iter().map(|(_, id)| id.as_str()))
        .collect();
    assert!(
        !allocated.contains(&"AAA-0002"),
        "the cross-org id must be stepped over, got {allocated:?}"
    );

    let landmine =
        crate::projects::io::read_work_item_by_row_id("other-org", "AAA-0002").expect("read");
    assert_eq!(
        landmine.expect("landmine survives").frontmatter.title,
        "cross-org landmine"
    );
}

/// `invoke` materialises the whole graph — every work item, every relation,
/// the run row, every audit row, the change watermark and the project's id
/// counter — inside one transaction, or it leaves nothing behind.
///
/// No seeded row can make a node collide any more (the allocator steps over
/// taken ids, see the test above), so the mid-graph failure is injected
/// directly at the storage layer: a `BEFORE INSERT` trigger aborts the
/// *third* `workitems` insert, i.e. after the root and the first step are
/// already written inside the transaction. The tail of the test re-invokes
/// with the trigger gone and proves the graph really is more than two nodes
/// deep — so the abort above genuinely landed mid-graph — and that the
/// failed attempt poisoned nothing.
#[test]
fn invoke_rolls_back_the_whole_graph_when_a_node_fails_mid_write() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");

    let count = |sql: &str| -> i64 {
        let connection = crate::projects::io::helpers::conn().expect("conn");
        connection
            .query_row(sql, [], |row| row.get(0))
            .unwrap_or_else(|err| panic!("{sql}: {err}"))
    };

    // Everything `apply` already wrote is the baseline the rollback must
    // return to — counting to zero would hide a partial commit of rows the
    // routine itself owns.
    let audit_before = count("SELECT COUNT(*) FROM pm_audit_events");
    let seq_before = count("SELECT COALESCE((SELECT seq FROM pm_change_seq WHERE id = 1), 0)");
    let next_id_before = count("SELECT next_work_item_id FROM projects WHERE slug = 'demo'");
    assert_eq!(count("SELECT COUNT(*) FROM workitems"), 0);

    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch(
            "CREATE TRIGGER pm_test_abort_third_work_item
             BEFORE INSERT ON workitems
             WHEN (SELECT COUNT(*) FROM workitems) >= 2
             BEGIN SELECT RAISE(ABORT, 'PM_TEST:MID_GRAPH_ABORT'); END;",
        )
        .expect("install mid-graph fault");
    drop(connection);

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-001".to_string());
    let err = invoke(&file.metadata.name, "demo", &inputs, None, Some("fire-x"))
        .expect_err("mid-graph write failure must fail the invoke");
    assert!(
        err.contains("PM_TEST:MID_GRAPH_ABORT"),
        "the invoke must fail on the injected fault, not on something else: {err}"
    );

    assert_eq!(
        count("SELECT COUNT(*) FROM workitems"),
        0,
        "no partial graph items survive — the root and the first step were already written"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM pm_routine_runs"),
        0,
        "no run row survives the rollback"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM pm_relations"),
        0,
        "no relations survive"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM pm_idempotency"),
        0,
        "failed invoke records no idempotency row"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM pm_audit_events"),
        audit_before,
        "the work.create audit rows written before the fault roll back too"
    );
    assert_eq!(
        count("SELECT COALESCE((SELECT seq FROM pm_change_seq WHERE id = 1), 0)"),
        seq_before,
        "the change watermark bump rolls back"
    );
    assert_eq!(
        count("SELECT next_work_item_id FROM projects WHERE slug = 'demo'"),
        next_id_before,
        "the project's short-id counter rolls back, so the burnt ids are reusable"
    );

    // Same key, fault removed: the retry must behave like a first invoke.
    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch("DROP TRIGGER pm_test_abort_third_work_item;")
        .expect("remove mid-graph fault");
    drop(connection);

    let run = invoke(&file.metadata.name, "demo", &inputs, None, Some("fire-x"))
        .expect("retry after a clean rollback");
    assert!(
        run.steps.len() >= 2,
        "the aborted third insert must have been a mid-graph node, not the last one: {:?}",
        run.steps
    );
    assert_eq!(
        run.root_short_id, "AAA-0001",
        "the rolled-back allocation is handed out again"
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM workitems"),
        1 + run.steps.len() as i64
    );
    assert_eq!(count("SELECT COUNT(*) FROM pm_routine_runs"), 1);
    assert_eq!(count("SELECT COUNT(*) FROM pm_idempotency"), 1);
}
