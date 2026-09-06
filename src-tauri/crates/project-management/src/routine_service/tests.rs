//! Integration tests for the portable routine application service.

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

fn named_fixture(name: &str) -> spec::RoutineSpecFile {
    let mut file = fixture();
    file.metadata.id = format!("routine-{name}");
    file.metadata.name = name.to_string();
    file.metadata.revision = None;
    file
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
fn invoke_commits_a_collaboration_outbox_row_for_every_generated_item() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    crate::projects::io::configure_project_org_collab_sync("personal-org", Some("personal-org"))
        .expect("enable collaboration");
    let file = fixture();
    apply(&file).expect("apply");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-COLLAB".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke");

    let mut expected_ids = vec![run.root_short_id.clone()];
    expected_ids.extend(run.steps.iter().map(|(_, id)| id.clone()));
    expected_ids.sort();
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let mut statement = connection
        .prepare(
            "SELECT entity_id FROM outbox_entries
              WHERE org_id = 'personal-org'
                AND entity_type = 'work_item'
                AND status = 'pending'
              ORDER BY entity_id",
        )
        .expect("prepare outbox query");
    let actual_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query outbox")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect outbox");
    assert_eq!(actual_ids, expected_ids);
}

#[test]
fn invoke_rolls_back_the_graph_when_collaboration_outbox_persistence_fails() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    crate::projects::io::configure_project_org_collab_sync("personal-org", Some("personal-org"))
        .expect("enable collaboration");
    let file = fixture();
    apply(&file).expect("apply");

    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch(
            "CREATE TRIGGER pm_test_abort_routine_outbox
             BEFORE INSERT ON outbox_entries
             WHEN NEW.org_id = 'personal-org' AND NEW.entity_type = 'work_item'
             BEGIN SELECT RAISE(ABORT, 'PM_TEST:ROUTINE_OUTBOX_ABORT'); END;",
        )
        .expect("install outbox fault");
    drop(connection);

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-OUTBOX-FAIL".to_string());
    let error = invoke(
        &file.metadata.name,
        "demo",
        &inputs,
        None,
        Some("outbox-fault"),
    )
    .expect_err("outbox failure must fail the invoke");
    assert!(error.contains("PM_TEST:ROUTINE_OUTBOX_ABORT"), "{error}");

    let connection = crate::projects::io::helpers::conn().expect("conn");
    for (table, expected) in [
        ("workitems", 0_i64),
        ("pm_routine_runs", 0),
        ("pm_relations", 0),
        ("pm_idempotency", 0),
        ("outbox_entries", 0),
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap_or_else(|query_error| panic!("count {table}: {query_error}"));
        assert_eq!(count, expected, "{table} must roll back with the invoke");
    }
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
fn legacy_conversion_expresses_create_direct_and_existing_root_modes() {
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
        RoutineOutputPolicy, RoutineResourceSelection, RoutineRunTarget, RoutineRunTemplate,
        RoutineTrigger, RoutineWorkspaceTarget,
    };
    let _sandbox = test_env::sandbox();

    let legacy = |mode: RoutineOutputMode, name: &str| RoutineDefinition {
        activations: Vec::new(),
        id: format!("legacy-{name}"),
        name: name.to_string(),
        description: "legacy description".to_string(),
        enabled: true,
        trigger: Some(RoutineTrigger::Cron {
            cron: "0 9 * * 1-5".to_string(),
            timezone: "America/Vancouver".to_string(),
        }),
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

    // Existing-root identity remains outside the spec and becomes a host
    // invocation binding.
    let mut updater = legacy(RoutineOutputMode::UpdateExistingWorkItem, "Refresher");
    updater.output_policy.update_work_item_short_id = Some("AAA-0009".to_string());
    updater.output_policy.update_work_item_project_slug = Some("demo".to_string());
    let (updated_file, _) = convert::convert_definition(&updater).expect("convert update");
    assert!(spec::validate(&updated_file).is_empty());
    assert_eq!(
        convert::invocation_target(&updater).expect("target"),
        RoutineInvocationTarget::ExistingProjectWork {
            project_slug: "demo".to_string(),
            root_work_item_id: "AAA-0009".to_string(),
        }
    );
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

fn legacy_definition(
    id: &str,
    name: &str,
    enabled: bool,
    trigger: crate::projects::types::RoutineTrigger,
) -> crate::projects::types::RoutineDefinition {
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
        RoutineOutputPolicy, RoutineResourceSelection, RoutineRunTarget, RoutineRunTemplate,
        RoutineWorkspaceTarget,
    };

    RoutineDefinition {
        activations: Vec::new(),
        id: id.to_string(),
        name: name.to_string(),
        description: "legacy bridge test".to_string(),
        enabled,
        trigger: Some(trigger),
        run_template: RoutineRunTemplate {
            prompt: "Do the bridged work".to_string(),
            target: RoutineRunTarget::AgentDefinition {
                agent_definition_id: None,
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
            create_work_item_project_slug: Some("demo".to_string()),
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
    }
}

#[test]
fn legacy_projection_ignores_unstarted_fires_and_gates_a_started_fire() {
    use crate::projects::types::{RoutineFireStatus, RoutineTrigger};

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let definition = legacy_definition(
        "legacy-handover",
        "Legacy Handover",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    );
    let saved = crate::projects::io::upsert_routine(definition).expect("seed mirror");
    let pending = crate::projects::io::create_routine_fire(&saved.id).expect("pending fire");
    let started = crate::projects::io::create_routine_fire(&saved.id).expect("started fire");
    crate::projects::io::mark_routine_fire_started(&started.id, "legacy-session", None)
        .expect("mark started");

    let converted = legacy_bridge::sync_definition(&saved).expect("handover");
    let fires = crate::projects::io::list_routine_fires(&saved.id).expect("legacy history");
    assert!(fires
        .iter()
        .any(|fire| fire.id == pending.id && fire.status == RoutineFireStatus::Pending));
    assert!(fires
        .iter()
        .any(|fire| fire.id == started.id && fire.status == RoutineFireStatus::Started));
    let legacy_active_id = format!("legacy:{}", started.id);
    assert_eq!(
        active_run_id(&converted.name).expect("active handover fire"),
        Some(legacy_active_id.clone())
    );
    let outcome = request_activation(
        &converted.name,
        &RoutineInvocationTarget::project("demo"),
        &Default::default(),
        "during-handover",
        spec::ConcurrencyPolicy::Queue,
        1,
    )
    .expect("portable activation during handover");
    assert!(matches!(
        outcome,
        RoutineActivationOutcome::Deferred(ref event)
            if event.status == "queued"
                && event.coalesced_run_id.as_deref()
                    == Some(legacy_active_id.as_str())
    ));

    crate::projects::io::mark_routine_fire_succeeded(&started.id).expect("legacy completion");
    assert!(!has_active_run(&converted.name).expect("handover settled"));
    assert_eq!(queued_activations(10).expect("queued activation").len(), 1);
}

#[test]
fn routine_projection_syncs_toggle_fire_history_rename_and_delete_without_ghosts() {
    use crate::projects::types::{RoutineFireStatus, RoutineTrigger};

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let definition = legacy_definition(
        "legacy-bridge",
        "Daily Bridge",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    );
    let saved = crate::projects::io::upsert_routine(definition).expect("seed mirror");
    let converted = legacy_bridge::sync_definition(&saved).expect("sync portable");
    assert!(
        crate::projects::io::read_routine(&saved.id)
            .expect("mirror")
            .enabled,
        "conversion must not disable the UI mirror"
    );

    let mut disabled = saved.clone();
    disabled.enabled = false;
    let disabled = crate::projects::io::upsert_routine(disabled).expect("disable mirror");
    legacy_bridge::sync_definition(&disabled).expect("disable portable");
    let overlay = legacy_bridge::overlay_definition(disabled.clone()).expect("overlay");
    assert!(!overlay.enabled);
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let portable_enabled: i64 = connection
        .query_row(
            "SELECT enabled FROM pm_routines WHERE name = ?1",
            rusqlite::params![converted.name],
            |row| row.get(0),
        )
        .expect("portable enabled");
    assert_eq!(portable_enabled, 0);
    drop(connection);

    let mut enabled = disabled;
    enabled.enabled = true;
    let enabled = crate::projects::io::upsert_routine(enabled).expect("enable mirror");
    legacy_bridge::sync_definition(&enabled).expect("enable portable");
    let fired = legacy_bridge::fire(&enabled.id).expect("portable Fire Now");
    assert_eq!(fired.fire.status, RoutineFireStatus::Started);
    let run_id = fired.fire.id.clone();
    let history = legacy_bridge::list_fires(&enabled.id).expect("unified history");
    assert!(history.iter().any(|fire| fire.id == run_id));
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let legacy_fires: i64 = connection
        .query_row("SELECT COUNT(*) FROM routine_fires", [], |row| row.get(0))
        .expect("legacy fire count");
    assert_eq!(legacy_fires, 0, "Fire Now must not execute the legacy path");
    connection
        .execute(
            "INSERT INTO pm_routine_webhooks (
                 routine_name, secret_hash, secret_hint, enabled,
                 consecutive_failures, paused_at, created_at, updated_at
             ) VALUES (?1, 'hash', 'hint', 1, 0, NULL, 1, 1)",
            rusqlite::params![converted.name],
        )
        .expect("seed webhook secret");
    drop(connection);

    let mut renamed = enabled;
    renamed.name = "Renamed Bridge".to_string();
    let renamed = crate::projects::io::upsert_routine(renamed).expect("rename mirror");
    let renamed_portable = legacy_bridge::sync_definition(&renamed).expect("rename portable");
    assert_eq!(converted.name, renamed_portable.name);
    assert_eq!(
        legacy_bridge::portable_name(&renamed.id).expect("projection"),
        Some(renamed_portable.name.clone())
    );
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let stable_rows: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_routines WHERE name = ?1",
            rusqlite::params![converted.name],
            |row| row.get(0),
        )
        .expect("old portable rows");
    let stable_run: String = connection
        .query_row(
            "SELECT routine_name FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run_id],
            |row| row.get(0),
        )
        .expect("stable history");
    assert_eq!(stable_rows, 1, "rename reuses the execution projection");
    assert_eq!(stable_run, renamed_portable.name);
    drop(connection);
    assert!(
        legacy_bridge::list_fires(&renamed.id)
            .expect("history after rename")
            .iter()
            .any(|fire| fire.id == run_id),
        "portable history follows the stable legacy id"
    );

    assert!(legacy_bridge::delete_definition(&renamed.id).expect("delete"));
    assert!(crate::projects::io::read_routine(&renamed.id).is_err());
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let (portable_rows, webhook_rows, retained_runs): (i64, i64, i64) = (
        connection
            .query_row("SELECT COUNT(*) FROM pm_routines", [], |row| row.get(0))
            .expect("portable count"),
        connection
            .query_row("SELECT COUNT(*) FROM pm_routine_webhooks", [], |row| {
                row.get(0)
            })
            .expect("webhook count"),
        connection
            .query_row("SELECT COUNT(*) FROM pm_routine_runs", [], |row| row.get(0))
            .expect("history count"),
    );
    assert_eq!(portable_rows, 0, "delete removes the scheduler candidate");
    assert_eq!(webhook_rows, 0, "delete destroys the live webhook secret");
    assert_eq!(retained_runs, 1, "delete preserves portable history");
    drop(connection);
    assert!(scheduled_candidates(i64::MAX)
        .expect("candidates")
        .is_empty());
}

#[test]
fn atomic_legacy_upsert_rolls_back_source_when_projection_audit_fails() {
    use crate::projects::types::RoutineTrigger;

    let _sandbox = test_env::sandbox();
    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_routine_projection_audit
             BEFORE INSERT ON pm_audit_events
             BEGIN
               SELECT RAISE(ABORT, 'injected routine audit failure');
             END;",
        )
        .expect("failure trigger");
    drop(connection);

    let result = legacy_bridge::upsert_definition(legacy_definition(
        "atomic-upsert",
        "Atomic Upsert",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    ));
    assert!(result.is_err(), "the injected audit failure must surface");

    let connection = crate::projects::io::helpers::conn().expect("read back");
    let source_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM routine_definitions WHERE id = 'atomic-upsert'",
            [],
            |row| row.get(0),
        )
        .expect("source count");
    let projection_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_routines WHERE routine_id = 'atomic-upsert'",
            [],
            |row| row.get(0),
        )
        .expect("projection count");
    assert_eq!(source_count, 0, "source write must roll back");
    assert_eq!(projection_count, 0, "projection write must roll back");
}

#[test]
fn atomic_legacy_delete_rolls_back_source_and_projection_together() {
    use crate::projects::types::RoutineTrigger;

    let _sandbox = test_env::sandbox();
    let saved = legacy_bridge::upsert_definition(legacy_definition(
        "atomic-delete",
        "Atomic Delete",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    ))
    .expect("seed atomic routine");
    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_routine_projection_delete
             BEFORE DELETE ON pm_routines
             BEGIN
               SELECT RAISE(ABORT, 'injected routine projection delete failure');
             END;",
        )
        .expect("failure trigger");
    drop(connection);

    assert!(legacy_bridge::delete_definition(&saved.id).is_err());

    let source =
        crate::projects::io::read_routine(&saved.id).expect("source remains active after rollback");
    assert!(source.enabled);
    assert!(
        legacy_bridge::portable_name(&saved.id)
            .expect("projection lookup")
            .is_some(),
        "scheduler projection must remain when source deletion rolls back"
    );
}

#[test]
fn one_time_disable_rolls_back_both_representations_on_failure() {
    use crate::projects::types::RoutineTrigger;

    let _sandbox = test_env::sandbox();
    let saved = legacy_bridge::upsert_definition(legacy_definition(
        "atomic-disable",
        "Atomic Disable",
        true,
        RoutineTrigger::OneTime {
            at: "2099-01-01T00:00:00Z".to_string(),
        },
    ))
    .expect("seed atomic routine");
    let portable_name = legacy_bridge::portable_name(&saved.id)
        .expect("projection lookup")
        .expect("projection name");
    let connection = crate::projects::io::helpers::conn().expect("conn");
    connection
        .execute_batch(
            "CREATE TRIGGER reject_routine_source_disable
             BEFORE UPDATE OF enabled ON routine_definitions
             BEGIN
               SELECT RAISE(ABORT, 'injected routine source disable failure');
             END;",
        )
        .expect("failure trigger");
    drop(connection);

    assert!(legacy_bridge::disable_one_time(&portable_name).is_err());

    let connection = crate::projects::io::helpers::conn().expect("read back");
    let projection_enabled: i64 = connection
        .query_row(
            "SELECT enabled FROM pm_routines WHERE name = ?1",
            [&portable_name],
            |row| row.get(0),
        )
        .expect("projection enabled");
    assert_eq!(projection_enabled, 1, "projection update must roll back");
    drop(connection);
    assert!(
        crate::projects::io::read_routine(&saved.id)
            .expect("source remains readable")
            .enabled,
        "editable source must remain enabled"
    );
}

#[test]
fn legacy_one_time_and_policy_conversion_remain_exactly_expressible() {
    use crate::projects::types::{RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineTrigger};

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let mut definition = legacy_definition(
        "legacy-one-time",
        "One Time Bridge",
        true,
        RoutineTrigger::OneTime {
            at: "2026-08-19T10:00:00Z".to_string(),
        },
    );
    definition.output_policy.concurrency_policy = RoutineConcurrencyPolicy::AlwaysCreate;
    definition.output_policy.catch_up_policy = RoutineCatchUpPolicy::RunAllLimited;
    definition.output_policy.max_catch_up_runs = 3;
    let saved = crate::projects::io::upsert_routine(definition).expect("seed");
    let converted = legacy_bridge::sync_definition(&saved).expect("convert");
    assert!(converted
        .warnings
        .iter()
        .all(|warning| { !warning.contains("one-time") && !warning.contains("concurrency") }));
    let candidates = scheduled_candidates(i64::MAX).expect("one-time candidate");
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.name == converted.name)
        .expect("one-time remains automatic");
    assert!(matches!(
        candidate.trigger,
        ScheduledTrigger::OneTime { .. }
    ));
    assert_eq!(candidate.concurrency, spec::ConcurrencyPolicy::Always);
    assert_eq!(candidate.catch_up, spec::CatchUpPolicy::RunAllLimited);
    assert_eq!(candidate.max_catch_up_runs, 3);
}

#[test]
fn activation_policies_are_durable_and_queue_promotes_exactly_once() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");
    let target = RoutineInvocationTarget::project("demo");
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-QUEUE".to_string());

    let first = match request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-first",
        spec::ConcurrencyPolicy::Queue,
        1,
    )
    .expect("first activation")
    {
        RoutineActivationOutcome::Invoked(run) => run,
        RoutineActivationOutcome::Deferred(event) => panic!("unexpected {event:?}"),
    };
    let queued = match request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-queued",
        spec::ConcurrencyPolicy::Queue,
        2,
    )
    .expect("queue")
    {
        RoutineActivationOutcome::Deferred(event) => event,
        RoutineActivationOutcome::Invoked(run) => panic!("unexpected {run:?}"),
    };
    assert_eq!(queued.status, "queued");
    let queued_replay = match request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-queued",
        spec::ConcurrencyPolicy::Queue,
        2,
    )
    .expect("queue replay")
    {
        RoutineActivationOutcome::Deferred(event) => event,
        RoutineActivationOutcome::Invoked(run) => panic!("unexpected {run:?}"),
    };
    assert_eq!(queued_replay.id, queued.id, "queue insert is idempotent");

    let skipped = request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-skipped",
        spec::ConcurrencyPolicy::Skip,
        3,
    )
    .expect("skip");
    assert!(matches!(
        skipped,
        RoutineActivationOutcome::Deferred(ref event) if event.status == "skipped"
    ));
    let coalesced = request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-coalesced",
        spec::ConcurrencyPolicy::Coalesce,
        4,
    )
    .expect("coalesce");
    assert!(matches!(
        coalesced,
        RoutineActivationOutcome::Deferred(ref event)
            if event.status == "coalesced"
                && event.coalesced_run_id.as_deref() == Some(first.run_id.as_str())
    ));
    let always = match request_activation(
        &file.metadata.name,
        &target,
        &inputs,
        "activation-always",
        spec::ConcurrencyPolicy::Always,
        5,
    )
    .expect("always")
    {
        RoutineActivationOutcome::Invoked(run) => run,
        RoutineActivationOutcome::Deferred(event) => panic!("unexpected {event:?}"),
    };

    for run in [&first, &always] {
        for (_, child_id) in &run.steps {
            set_child_status("demo", child_id, "done");
        }
    }
    assert!(!has_active_run(&file.metadata.name).expect("all active runs settled"));
    let pending = queued_activations(256).expect("durable queue");
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].event_id, queued.id);
    let promoted = promote_queued_activation(&pending[0])
        .expect("promote")
        .expect("queue is idle");
    let replay = invoke_target(
        &pending[0].routine_name,
        &pending[0].target,
        &pending[0].inputs,
        None,
        Some(&pending[0].invoke_key),
    )
    .expect("promotion replay");
    assert_eq!(promoted.run_id, replay.run_id);
    assert!(queued_activations(256).expect("queue drained").is_empty());
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let runs: i64 = connection
        .query_row("SELECT COUNT(*) FROM pm_routine_runs", [], |row| row.get(0))
        .expect("run count");
    assert_eq!(runs, 3, "first + always + one queued promotion only");
}

#[test]
fn concurrent_skip_queue_and_coalesce_decisions_cannot_double_invoke() {
    use std::sync::{Arc, Barrier};

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    for (name, policy, deferred_status) in [
        ("concurrent-skip", spec::ConcurrencyPolicy::Skip, "skipped"),
        ("concurrent-queue", spec::ConcurrencyPolicy::Queue, "queued"),
        (
            "concurrent-coalesce",
            spec::ConcurrencyPolicy::Coalesce,
            "coalesced",
        ),
    ] {
        let file = named_fixture(name);
        apply(&file).expect("apply concurrent fixture");
        let mut inputs = std::collections::BTreeMap::new();
        inputs.insert("requirement_id".to_string(), "REQ-RACE".to_string());
        let barrier = Arc::new(Barrier::new(2));
        let first_key = format!("{name}-race-first");
        let second_key = format!("{name}-race-second");
        let outcomes = std::thread::scope(|scope| {
            let first_barrier = Arc::clone(&barrier);
            let first_inputs = inputs.clone();
            let first = scope.spawn(move || {
                first_barrier.wait();
                request_activation(
                    name,
                    &RoutineInvocationTarget::project("demo"),
                    &first_inputs,
                    &first_key,
                    policy,
                    1,
                )
            });
            let second_barrier = Arc::clone(&barrier);
            let second_inputs = inputs.clone();
            let second = scope.spawn(move || {
                second_barrier.wait();
                request_activation(
                    name,
                    &RoutineInvocationTarget::project("demo"),
                    &second_inputs,
                    &second_key,
                    policy,
                    1,
                )
            });
            vec![
                first.join().expect("first thread").expect("first decision"),
                second
                    .join()
                    .expect("second thread")
                    .expect("second decision"),
            ]
        });
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(outcome, RoutineActivationOutcome::Invoked(_)))
                .count(),
            1,
            "{name} must have exactly one CAS winner"
        );
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| matches!(
                    outcome,
                    RoutineActivationOutcome::Deferred(event)
                        if event.status == deferred_status
                ))
                .count(),
            1,
            "{name} must durably record the losing decision"
        );
        let connection = crate::projects::io::helpers::conn().expect("conn");
        let (runs, guards): (i64, i64) = (
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pm_routine_runs WHERE routine_name = ?1",
                    rusqlite::params![name],
                    |row| row.get(0),
                )
                .expect("run count"),
            connection
                .query_row(
                    "SELECT COUNT(*) FROM pm_routine_activation_guards WHERE routine_name = ?1",
                    rusqlite::params![name],
                    |row| row.get(0),
                )
                .expect("guard count"),
        );
        assert_eq!(runs, 1);
        assert_eq!(guards, 0, "the CAS guard releases after the decision");
    }
}

#[test]
fn concurrent_always_activations_have_collision_free_run_ids() {
    use std::collections::HashSet;
    use std::sync::{Arc, Barrier};

    const CONCURRENCY: usize = 8;
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = named_fixture("concurrent-always");
    apply(&file).expect("apply concurrent fixture");
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-ALWAYS".to_string());
    let barrier = Arc::new(Barrier::new(CONCURRENCY));
    let outcomes = std::thread::scope(|scope| {
        let handles = (0..CONCURRENCY)
            .map(|index| {
                let barrier = Arc::clone(&barrier);
                let inputs = inputs.clone();
                let routine_name = file.metadata.name.clone();
                scope.spawn(move || {
                    barrier.wait();
                    request_activation(
                        &routine_name,
                        &RoutineInvocationTarget::project("demo"),
                        &inputs,
                        &format!("always-{index}"),
                        spec::ConcurrencyPolicy::Always,
                        1,
                    )
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .expect("always thread")
                    .expect("always invoke")
            })
            .collect::<Vec<_>>()
    });
    let run_ids = outcomes
        .into_iter()
        .map(|outcome| match outcome {
            RoutineActivationOutcome::Invoked(run) => run.run_id,
            RoutineActivationOutcome::Deferred(event) => panic!("unexpected {event:?}"),
        })
        .collect::<HashSet<_>>();
    assert_eq!(run_ids.len(), CONCURRENCY);
    assert!(run_ids
        .iter()
        .all(|run_id| run_id.starts_with("run_") && run_id.len() == 36));
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
fn convert_all_hands_projectless_and_project_bound_rows_to_one_scheduler() {
    use crate::projects::types::{
        RoutineCatchUpPolicy, RoutineConcurrencyPolicy, RoutineDefinition, RoutineOutputMode,
        RoutineOutputPolicy, RoutineResourceSelection, RoutineRunTarget, RoutineRunTemplate,
        RoutineTrigger, RoutineWorkspaceTarget,
    };
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");

    let legacy = |name: &str, slug: Option<&str>| RoutineDefinition {
        activations: Vec::new(),
        id: format!("legacy-{name}"),
        name: name.to_string(),
        description: "legacy description".to_string(),
        enabled: true,
        trigger: Some(RoutineTrigger::Cron {
            cron: "0 9 * * 1-5".to_string(),
            timezone: "UTC".to_string(),
        }),
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
        "the legacy row remains an enabled UI mirror after scheduler handover"
    );
    let bound_after = crate::projects::io::read_routine(&bound.id).expect("read");
    assert!(
        bound_after.enabled,
        "scope-bound UI state mirrors the enabled portable activation"
    );

    let connection = crate::projects::io::helpers::conn().expect("conn");
    let unbound_target: String = connection
        .query_row(
            "SELECT default_scope FROM pm_routines WHERE name = 'unbound'",
            [],
            |row| row.get(0),
        )
        .expect("projectless binding");
    assert_eq!(unbound_target, "org:personal-org");
    let enabled_portable: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_routines WHERE enabled = 1",
            [],
            |row| row.get(0),
        )
        .expect("enabled portable rows");
    assert_eq!(
        enabled_portable, 2,
        "portable is the sole scheduler authority"
    );
}

#[test]
fn invoke_can_attach_steps_to_an_existing_root_work_item() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");
    crate::work_service::create_project_work_item(
        "demo",
        "AAA-0042",
        &crate::work_service::CreateWorkItemRequest {
            title: "Existing root".to_string(),
            body: "Keep this body".to_string(),
            ..Default::default()
        },
        None,
    )
    .expect("seed root");

    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-ROOT".to_string());
    let actor = crate::projects::types::WorkItemMutationActor {
        id: "human:owner".to_string(),
        name: "Owner".to_string(),
    };
    let run = invoke_target(
        &file.metadata.name,
        &RoutineInvocationTarget::ExistingProjectWork {
            project_slug: "demo".to_string(),
            root_work_item_id: "AAA-0042".to_string(),
        },
        &inputs,
        Some(&actor),
        Some("existing-root"),
    )
    .expect("invoke existing root");
    assert_eq!(run.root_short_id, "AAA-0042");
    let root = crate::projects::io::read_work_item("demo", "AAA-0042").expect("root");
    assert_eq!(root.frontmatter.title, "Existing root");
    assert_eq!(root.body, "Keep this body");
    for (_, child_id) in &run.steps {
        let child = crate::projects::io::read_work_item("demo", child_id).expect("child");
        assert_eq!(child.frontmatter.parent.as_deref(), Some("AAA-0042"));
    }
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let child_subscriptions: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_work_item_subscriptions
              WHERE subscriber_id = 'human:owner' AND reason = 'creator'",
            [],
            |row| row.get(0),
        )
        .expect("subscriptions");
    assert_eq!(child_subscriptions, run.steps.len() as i64);
}

#[test]
fn invoke_without_a_project_materializes_an_org_scoped_graph() {
    let _sandbox = test_env::sandbox();
    let file = fixture();
    apply(&file).expect("apply");
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-ORG".to_string());

    let run = invoke_target(
        &file.metadata.name,
        &RoutineInvocationTarget::standalone(None),
        &inputs,
        None,
        Some("org-run"),
    )
    .expect("projectless invoke");
    crate::projects::io::read_standalone_work_item(None, &run.root_short_id)
        .expect("standalone root");
    for (_, child_id) in &run.steps {
        crate::projects::io::read_standalone_work_item(None, child_id).expect("standalone child");
    }
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let scope_id: String = connection
        .query_row(
            "SELECT scope_id FROM pm_routine_runs WHERE id = ?1",
            rusqlite::params![run.run_id],
            |row| row.get(0),
        )
        .expect("run scope");
    assert_eq!(scope_id, "org:personal-org");
    let status = run_status(&run.run_id).expect("standalone run status");
    assert_eq!(status["scopeId"], "org:personal-org");
    assert_eq!(status["workItems"].as_array().map(Vec::len), Some(3));
}

#[test]
fn cancel_run_is_idempotent_and_stops_owned_execution_without_cancelling_work() {
    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let file = fixture();
    apply(&file).expect("apply");
    let mut inputs = std::collections::BTreeMap::new();
    inputs.insert("requirement_id".to_string(), "REQ-CANCEL".to_string());
    let run = invoke(&file.metadata.name, "demo", &inputs, None, None).expect("invoke");
    let child_id = run.steps[0].1.clone();
    let work_run =
        crate::work_run_service::enqueue(crate::projects::types::EnqueueWorkItemRunRequest {
            project_slug: Some("demo".to_string()),
            org_id: crate::projects::types::PERSONAL_ORG_ID.to_string(),
            work_item_id: child_id.clone(),
            trigger: crate::projects::types::WorkItemRunTrigger::Routine {
                routine_id: file.metadata.id.clone(),
                fire_id: run.run_id.clone(),
            },
            target_snapshot: crate::projects::types::WorkItemRunTargetSnapshot::new(
                crate::projects::types::WorkItemRunTarget::StartWorkItem {
                    account_id: None,
                    model_id: None,
                },
            ),
            input: serde_json::json!({}),
            idempotency_key: "routine-cancel-owned-run".to_string(),
            max_attempts: 1,
            parent_run_id: None,
        })
        .expect("enqueue owned run");

    let first = cancel_run(&run.run_id, None).expect("cancel");
    assert!(first.changed);
    assert_eq!(first.cancelled_work_item_runs, 1);
    assert_eq!(stored_run_status(&run.run_id), "cancelled");
    assert_eq!(
        crate::work_run_service::read(&work_run.id)
            .expect("work run")
            .status,
        crate::projects::types::WorkItemRunStatus::Cancelled
    );
    assert_ne!(
        crate::projects::io::read_work_item("demo", &child_id)
            .expect("child remains")
            .frontmatter
            .status,
        "cancelled",
        "Routine cancellation must not silently cancel product intent"
    );
    let connection = crate::projects::io::helpers::conn().expect("conn");
    let scoped_cancel_audits: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM pm_audit_events
              WHERE operation = 'routine.cancel' AND entity_id = ?1
                AND project_slug = 'demo'",
            rusqlite::params![run.run_id],
            |row| row.get(0),
        )
        .expect("cancel audit");
    assert_eq!(scoped_cancel_audits, 1);
    drop(connection);

    let second = cancel_run(&run.run_id, None).expect("idempotent cancel");
    assert!(!second.changed);
    assert_eq!(second.status, "cancelled");
}

#[test]
fn scheduled_candidate_scan_is_due_only_and_hard_bounded() {
    let _sandbox = test_env::sandbox();
    let file = fixture();
    let canonical = spec::canonicalize(&file).expect("canonical");
    let hash = snapshot_hash(&canonical);
    let mut manual_only = file.clone();
    manual_only
        .spec
        .activations
        .retain(|activation| matches!(activation, spec::Activation::Manual { .. }));
    let manual_canonical = spec::canonicalize(&manual_only).expect("manual canonical");
    let manual_hash = snapshot_hash(&manual_canonical);
    let mut connection = crate::projects::io::helpers::conn().expect("conn");
    let tx = connection.transaction().expect("tx");
    for index in 0..(MAX_SCHEDULE_CANDIDATES_PER_TICK + 20) {
        tx.execute(
            "INSERT INTO pm_routines (
                 name, routine_id, spec_json, spec_hash, revision, enabled,
                 default_scope, last_evaluated_at, next_fire_at, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 1, 1, 'org:personal-org', NULL, NULL, 0, 0)",
            rusqlite::params![
                format!("routine-{index:04}"),
                format!("routine_id_{index:04}"),
                canonical,
                hash,
            ],
        )
        .expect("seed candidate");
    }
    tx.execute(
        "INSERT INTO pm_routines (
             name, routine_id, spec_json, spec_hash, revision, enabled,
             default_scope, last_evaluated_at, next_fire_at, created_at, updated_at
         ) VALUES ('manual-only', 'manual-only-id', ?1, ?2, 1, 1,
                   'org:personal-org', NULL, NULL, 0, 0)",
        rusqlite::params![manual_canonical, manual_hash],
    )
    .expect("seed manual-only");
    tx.execute(
        "INSERT INTO pm_routines (
             name, routine_id, spec_json, spec_hash, revision, enabled,
             default_scope, last_evaluated_at, next_fire_at, created_at, updated_at
         ) VALUES ('future', 'future-id', ?1, ?2, 1, 1,
                   'org:personal-org', NULL, 9999999999999, 0, 0)",
        rusqlite::params![canonical, hash],
    )
    .expect("seed future");
    tx.commit().expect("commit");

    let candidates = scheduled_candidates(1).expect("candidates");
    assert_eq!(candidates.len(), MAX_SCHEDULE_CANDIDATES_PER_TICK);
    assert!(candidates
        .iter()
        .all(|candidate| candidate.name != "future" && candidate.name != "manual-only"));
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

#[test]
fn explicit_activations_replace_the_trigger_and_inherit_policies() {
    let _sandbox = test_env::sandbox();
    let mut definition = legacy_definition(
        "routine_multi",
        "Multi Activation",
        true,
        crate::projects::types::RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    );
    definition.activations = vec![
        spec::Activation::Schedule {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
            policies: spec::ActivationPolicies::default(),
        },
        spec::Activation::ProviderEvent {
            provider: "github".to_string(),
            event_kind: "pull_request".to_string(),
            filter: None,
            policies: spec::ActivationPolicies::default(),
        },
    ];

    let (file, _warnings) = convert::convert_definition(&definition).expect("convert");
    assert_eq!(file.spec.activations.len(), 2, "explicit list wins");
    let schedule_policies = match &file.spec.activations[0] {
        spec::Activation::Schedule { policies, .. } => policies,
        other => panic!("expected schedule first, got {other:?}"),
    };
    assert!(
        schedule_policies.concurrency_policy.is_some(),
        "entries without policies inherit the routine's converted intent"
    );
    assert!(matches!(
        &file.spec.activations[1],
        spec::Activation::ProviderEvent { provider, .. } if provider == "github"
    ));
    assert!(
        spec::validate(&file).is_empty(),
        "converted multi-activation spec passes validation"
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

#[test]
fn portable_activation_stamps_routine_provenance_on_generated_work_items() {
    use crate::projects::types::RoutineTrigger;

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let mut definition = legacy_definition(
        "legacy-provenance",
        "Provenance Routine",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    );
    definition.output_policy.concurrency_policy =
        crate::projects::types::RoutineConcurrencyPolicy::AlwaysCreate;
    let saved = legacy_bridge::upsert_definition(definition).expect("seed definition");

    let fired = legacy_bridge::fire(&saved.id).expect("Fire Now");
    let short_id = fired
        .fire
        .work_item_id
        .clone()
        .expect("fire materialized a work item");
    let item = crate::projects::io::read_work_item("demo", &short_id).expect("generated item");
    let source = item
        .frontmatter
        .routine_source
        .expect("generated work item carries routine provenance");
    assert_eq!(source.routine_id, saved.id);
    assert_eq!(source.routine_name, saved.name);
    assert_eq!(source.routine_fire_id, fired.fire.id);
    assert!(!source.fired_at.is_empty());

    // The portable execution name is frozen at first projection; provenance
    // must follow the editable definition's display name instead.
    let mut renamed = saved.clone();
    renamed.name = "Renamed Provenance Routine".to_string();
    let renamed = legacy_bridge::upsert_definition(renamed).expect("rename definition");
    let refired = legacy_bridge::fire(&renamed.id).expect("Fire Now after rename");
    let renamed_short_id = refired
        .fire
        .work_item_id
        .clone()
        .expect("second fire materialized a work item");
    let renamed_item =
        crate::projects::io::read_work_item("demo", &renamed_short_id).expect("generated item");
    let renamed_source = renamed_item
        .frontmatter
        .routine_source
        .expect("second generated work item carries routine provenance");
    assert_eq!(renamed_source.routine_id, saved.id);
    assert_eq!(renamed_source.routine_name, "Renamed Provenance Routine");
}

type RoutineChangedRecord = (String, Option<String>, String);

static ROUTINE_CHANGED_LOG: std::sync::OnceLock<std::sync::Mutex<Vec<RoutineChangedRecord>>> =
    std::sync::OnceLock::new();

fn routine_changed_log() -> &'static std::sync::Mutex<Vec<RoutineChangedRecord>> {
    ROUTINE_CHANGED_LOG.get_or_init(|| {
        crate::projects::events::register_routine_changed_notifier(Box::new(|event| {
            if let Some(log) = ROUTINE_CHANGED_LOG.get() {
                log.lock().expect("routine changed log").push((
                    event.routine_id,
                    event.fire_id,
                    event.status,
                ));
            }
        }));
        std::sync::Mutex::new(Vec::new())
    })
}

fn routine_changed_records(routine_id: &str) -> Vec<RoutineChangedRecord> {
    routine_changed_log()
        .lock()
        .expect("routine changed log")
        .iter()
        .filter(|(id, _, _)| id == routine_id)
        .cloned()
        .collect()
}

#[test]
fn routine_mutations_notify_the_routines_surface() {
    use crate::projects::types::RoutineTrigger;

    let _sandbox = test_env::sandbox();
    crate::work_service::tests_support::seed_project("demo", "p1");
    let _ = routine_changed_log();

    let saved = legacy_bridge::upsert_definition(legacy_definition(
        "legacy-notify",
        "Notify Routine",
        true,
        RoutineTrigger::Cron {
            cron: "0 9 * * *".to_string(),
            timezone: "UTC".to_string(),
        },
    ))
    .expect("seed definition");
    assert!(
        routine_changed_records(&saved.id)
            .iter()
            .any(|(_, fire_id, status)| fire_id.is_none() && status == "updated"),
        "committed definition upsert must notify: {:?}",
        routine_changed_records(&saved.id)
    );

    let fired = legacy_bridge::fire(&saved.id).expect("Fire Now");
    assert!(
        routine_changed_records(&saved.id)
            .iter()
            .any(|(_, fire_id, status)| fire_id.as_deref() == Some(fired.fire.id.as_str())
                && status == "started"),
        "committed activation must notify: {:?}",
        routine_changed_records(&saved.id)
    );

    assert!(legacy_bridge::delete_definition(&saved.id).expect("delete definition"));
    assert!(
        routine_changed_records(&saved.id)
            .iter()
            .any(|(_, fire_id, status)| fire_id.is_none() && status == "deleted"),
        "committed definition delete must notify: {:?}",
        routine_changed_records(&saved.id)
    );
}

#[test]
fn portable_activation_stamps_routine_provenance_on_standalone_work_items() {
    use crate::projects::types::{RoutineConcurrencyPolicy, RoutineTrigger};

    let _sandbox = test_env::sandbox();
    let future_at = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    let mut definition = legacy_definition(
        "legacy-standalone-provenance",
        "Standalone Provenance Routine",
        true,
        RoutineTrigger::OneTime { at: future_at },
    );
    definition.output_policy.concurrency_policy = RoutineConcurrencyPolicy::AlwaysCreate;
    definition.output_policy.create_work_item_project_slug = None;
    definition.output_policy.create_work_item_title = Some("Standalone routine output".to_string());
    definition.output_policy.create_work_item_body = Some("Created by a routine fire.".to_string());
    let saved = legacy_bridge::upsert_definition(definition).expect("seed definition");

    let fired = legacy_bridge::fire(&saved.id).expect("Fire Now");
    let short_id = fired
        .fire
        .work_item_id
        .clone()
        .expect("fire materialized a standalone work item");
    let item = crate::projects::io::read_standalone_work_item(None, &short_id)
        .expect("standalone generated item");
    let source = item
        .frontmatter
        .routine_source
        .expect("standalone generated work item carries routine provenance");
    assert_eq!(source.routine_id, saved.id);
    assert_eq!(source.routine_name, saved.name);
    assert_eq!(source.routine_fire_id, fired.fire.id);
    assert!(!source.fired_at.is_empty());
}
