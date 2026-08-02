use std::collections::{BTreeMap, BTreeSet};

use super::agent_org::{post_agent_org_json as post_json, unique_run_id};
use super::config::Config;
use super::harness;

const SEED_RUN_PATH: &str = "/agent/test/agent-org/stale-workers/seed-run";
const SEED_RELATED_PATH: &str = "/agent/test/agent-org/session-delete/fixture/seed-related";
const SNAPSHOT_PATH: &str = "/agent/test/agent-org/session-delete/snapshot";
const SUPPORT_SNAPSHOT_PATH: &str = "/agent/test/agent-org/session-delete/fixture/support-snapshot";
const DELETE_ATTEMPT_PATH: &str = "/agent/test/agent-org/session-delete/attempt";
const FAULT_ARM_PATH: &str = "/agent/test/agent-org/session-delete/fault/arm";
const FAULT_DISARM_PATH: &str = "/agent/test/agent-org/session-delete/fault/disarm";
const RESTART_PATH: &str = "/agent/test/agent-org/simulate-app-restart";
const RESUME_PATH: &str = "/agent/test/agent-org/run/resume";
const DELETE_FAULT_ERROR: &str = "e2e_agent_org_session_delete_fault";

struct FixtureIds {
    root: String,
    history_worker: String,
    live_worker: String,
    unrelated_root: String,
    unrelated_worker: String,
}

impl FixtureIds {
    fn new(label: &str) -> Self {
        let fixture_id = unique_run_id(label);
        Self {
            root: format!("{fixture_id}-root"),
            history_worker: format!("{fixture_id}-worker-history"),
            live_worker: format!("{fixture_id}-worker-live"),
            unrelated_root: format!("{fixture_id}-unrelated-root"),
            unrelated_worker: format!("{fixture_id}-unrelated-worker"),
        }
    }

    fn target_session_ids(&self) -> Vec<String> {
        vec![
            self.root.clone(),
            self.history_worker.clone(),
            self.live_worker.clone(),
        ]
    }
}

struct SeededFixture {
    history_run: String,
    live_run: String,
    unrelated_run: String,
}

impl SeededFixture {
    fn target_run_ids(&self) -> Vec<String> {
        vec![self.history_run.clone(), self.live_run.clone()]
    }
}

struct ScenarioReport {
    details: serde_json::Value,
    checks: Vec<(&'static str, bool)>,
}

#[derive(serde::Deserialize, serde::Serialize, PartialEq)]
struct StatusRow {
    status: String,
}

#[derive(serde::Deserialize, serde::Serialize, PartialEq)]
struct MappingRow {
    org_run_id: String,
    member_id: String,
    session_id: String,
    role: String,
}

#[derive(Debug, Default, serde::Deserialize, serde::Serialize, PartialEq)]
struct SupportCounts {
    tasks: u64,
    task_events: u64,
    inbox: u64,
    approvals: u64,
    run_progress: u64,
    finality_requests: u64,
    run_turn_intents: u64,
    session_turn_intents: u64,
}

impl SupportCounts {
    fn expected(run_count: u64, completed_count: u64) -> Self {
        Self {
            tasks: run_count,
            task_events: run_count,
            inbox: run_count,
            approvals: run_count,
            run_progress: run_count,
            finality_requests: completed_count,
            run_turn_intents: run_count,
            session_turn_intents: run_count,
        }
    }

    fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(serde::Deserialize, serde::Serialize, PartialEq)]
struct Snapshot {
    sessions: BTreeMap<String, Option<StatusRow>>,
    runs: BTreeMap<String, Option<StatusRow>>,
    mappings: Vec<MappingRow>,
    #[serde(default)]
    fence_count: u64,
    #[serde(default)]
    support_counts: SupportCounts,
}

#[derive(serde::Deserialize)]
struct SupportSnapshot {
    fence_count: u64,
    support_counts: SupportCounts,
}

impl Snapshot {
    fn rows_match(
        rows: &BTreeMap<String, Option<StatusRow>>,
        ids: &[String],
        present: bool,
    ) -> bool {
        ids.iter()
            .all(|id| rows.get(id).is_some_and(|row| row.is_some() == present))
    }

    fn has_expected_topology(&self, ids: &FixtureIds, seeded: &SeededFixture) -> bool {
        let actual = self
            .mappings
            .iter()
            .map(|mapping| {
                (
                    mapping.org_run_id.as_str(),
                    mapping.member_id.as_str(),
                    mapping.session_id.as_str(),
                    mapping.role.as_str(),
                )
            })
            .collect::<BTreeSet<_>>();
        let expected = BTreeSet::from([
            (
                seeded.history_run.as_str(),
                "coordinator",
                ids.root.as_str(),
                "coordinator",
            ),
            (
                seeded.history_run.as_str(),
                "history-member",
                ids.history_worker.as_str(),
                "worker",
            ),
            (
                seeded.live_run.as_str(),
                "coordinator",
                ids.root.as_str(),
                "coordinator",
            ),
            (
                seeded.live_run.as_str(),
                "live-member",
                ids.live_worker.as_str(),
                "worker",
            ),
        ]);
        self.mappings.len() == actual.len() && actual == expected
    }

    fn run_status(&self, run_id: &str) -> Option<&str> {
        self.runs
            .get(run_id)
            .and_then(Option::as_ref)
            .map(|row| row.status.as_str())
    }

    fn target_is_absent(&self, ids: &FixtureIds, seeded: &SeededFixture) -> bool {
        Self::rows_match(&self.sessions, &ids.target_session_ids(), false)
            && Self::rows_match(&self.runs, &seeded.target_run_ids(), false)
            && self.mappings.is_empty()
            && self.fence_count == 0
            && self.support_counts.is_empty()
    }
}

fn require_ok(response: serde_json::Value, action: &str) -> Result<serde_json::Value, String> {
    if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
        Ok(response)
    } else {
        Err(format!("{action} failed: {response}"))
    }
}

async fn seed_run(
    cfg: &Config,
    root_session_id: &str,
    run_label: &str,
    run_status: &str,
    worker_session_id: &str,
) -> Result<String, String> {
    let member_id = format!("{run_label}-member");
    let root_status = match run_status {
        "paused" => "paused",
        _ => "idle",
    };
    let body = serde_json::json!({
        "org_id": format!("{root_session_id}:{run_label}"),
        "coordinator_agent_id": "builtin:sde",
        "root_session_id": root_session_id,
        "root_status": root_status,
        "run_status": run_status,
        "workers": [{
            "member_id": member_id,
            "agent_definition_id": "builtin:explore",
            "session_id": worker_session_id,
            "status": run_status,
        }],
    });
    let response = require_ok(post_json(cfg, SEED_RUN_PATH, body).await?, "seed run")?;
    response
        .get("org_run_id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("seed response omitted org_run_id: {response}"))
}

async fn seed_related(
    cfg: &Config,
    root_session_id: &str,
    runs: &[(&str, &str, &str, Option<&str>)],
) -> Result<(), String> {
    let runs = runs
        .iter()
        .map(|(org_run_id, worker_session_id, member_id, final_status)| {
            serde_json::json!({
                "org_run_id": org_run_id,
                "worker_session_id": worker_session_id,
                "member_id": member_id,
                "final_status": final_status,
            })
        })
        .collect::<Vec<_>>();
    require_ok(
        post_json(
            cfg,
            SEED_RELATED_PATH,
            serde_json::json!({ "root_session_id": root_session_id, "runs": runs }),
        )
        .await?,
        "seed related rows",
    )?;
    Ok(())
}

async fn seed_fixture(cfg: &Config, ids: &FixtureIds) -> Result<SeededFixture, String> {
    let history_run = seed_run(cfg, &ids.root, "history", "paused", &ids.history_worker).await?;
    seed_related(
        cfg,
        &ids.root,
        &[(
            &history_run,
            &ids.history_worker,
            "history-member",
            Some("completed"),
        )],
    )
    .await?;

    let live_run = seed_run(cfg, &ids.root, "live", "paused", &ids.live_worker).await?;
    seed_related(
        cfg,
        &ids.root,
        &[(&live_run, &ids.live_worker, "live-member", None)],
    )
    .await?;

    let unrelated_run = seed_run(
        cfg,
        &ids.unrelated_root,
        "unrelated",
        "paused",
        &ids.unrelated_worker,
    )
    .await?;

    seed_related(
        cfg,
        &ids.unrelated_root,
        &[(
            &unrelated_run,
            &ids.unrelated_worker,
            "unrelated-member",
            Some("completed"),
        )],
    )
    .await?;

    Ok(SeededFixture {
        history_run,
        live_run,
        unrelated_run,
    })
}

async fn snapshot(
    cfg: &Config,
    root_session_id: &str,
    session_ids: &[String],
    run_ids: &[String],
) -> Result<Snapshot, String> {
    let body = serde_json::json!({ "session_ids": session_ids, "run_ids": run_ids });
    let response = require_ok(
        post_json(cfg, SNAPSHOT_PATH, body).await?,
        "inspect fixture",
    )?;
    let mut snapshot: Snapshot = serde_json::from_value(response)
        .map_err(|error| format!("invalid topology snapshot: {error}"))?;
    let support = require_ok(
        post_json(
            cfg,
            SUPPORT_SNAPSHOT_PATH,
            serde_json::json!({
                "root_session_id": root_session_id,
                "session_ids": session_ids,
                "run_ids": run_ids,
            }),
        )
        .await?,
        "inspect support rows",
    )?;
    let support: SupportSnapshot = serde_json::from_value(support)
        .map_err(|error| format!("invalid support snapshot: {error}"))?;
    snapshot.fence_count = support.fence_count;
    snapshot.support_counts = support.support_counts;
    Ok(snapshot)
}

async fn delete_attempt(cfg: &Config, session_id: &str) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "session_id": session_id });
    post_json(cfg, DELETE_ATTEMPT_PATH, body).await
}

fn response_ok(response: &serde_json::Value) -> bool {
    response.get("ok").and_then(serde_json::Value::as_bool) == Some(true)
}

fn receipt_has_exact_ids(response: &serde_json::Value, expected: &[String]) -> bool {
    let Some(ids) = response
        .pointer("/receipt/deletedSessionIds")
        .and_then(serde_json::Value::as_array)
    else {
        return false;
    };
    let actual = ids
        .iter()
        .filter_map(serde_json::Value::as_str)
        .collect::<BTreeSet<_>>();
    let expected = expected.iter().map(String::as_str).collect::<BTreeSet<_>>();
    ids.len() == actual.len() && actual == expected
}

async fn cleanup_fixture(cfg: &Config, ids: &FixtureIds) -> bool {
    let disarm_ok = post_json(cfg, FAULT_DISARM_PATH, serde_json::json!({}))
        .await
        .is_ok_and(|response| response_ok(&response));
    let mut cleanup_ok = disarm_ok;
    for root_session_id in [&ids.root, &ids.unrelated_root] {
        let result = delete_attempt(cfg, root_session_id).await;
        if !result.as_ref().is_ok_and(response_ok) {
            cleanup_ok = false;
            eprintln!("[agent-org-delete-cleanup] {root_session_id}: {result:?}");
        }
    }
    cleanup_ok
}

async fn run_success_scenario(cfg: &Config, ids: &FixtureIds) -> Result<ScenarioReport, String> {
    let seeded = seed_fixture(cfg, ids).await?;
    let target_session_ids = ids.target_session_ids();
    let target_run_ids = seeded.target_run_ids();
    let before = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let unrelated_session_ids = vec![ids.unrelated_root.clone(), ids.unrelated_worker.clone()];
    let unrelated_run_ids = vec![seeded.unrelated_run.clone()];
    let unrelated_before = snapshot(
        cfg,
        &ids.unrelated_root,
        &unrelated_session_ids,
        &unrelated_run_ids,
    )
    .await?;

    let deletion = delete_attempt(cfg, &ids.root).await?;
    let after = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let unrelated_after = snapshot(
        cfg,
        &ids.unrelated_root,
        &unrelated_session_ids,
        &unrelated_run_ids,
    )
    .await?;
    let repeated_deletion = delete_attempt(cfg, &ids.root).await?;
    let restart = post_json(cfg, RESTART_PATH, serde_json::json!({})).await?;
    let after_restart = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;

    let fixture_complete = Snapshot::rows_match(&before.sessions, &target_session_ids, true)
        && Snapshot::rows_match(&before.runs, &target_run_ids, true)
        && before.has_expected_topology(ids, &seeded)
        && before.fence_count == 0
        && before.support_counts == SupportCounts::expected(2, 1)
        && Snapshot::rows_match(&unrelated_before.sessions, &unrelated_session_ids, true)
        && Snapshot::rows_match(&unrelated_before.runs, &unrelated_run_ids, true)
        && unrelated_before.fence_count == 0
        && unrelated_before.support_counts == SupportCounts::expected(1, 1);
    let receipt_exact =
        response_ok(&deletion) && receipt_has_exact_ids(&deletion, &target_session_ids);
    let isolation_and_idempotency =
        unrelated_before == unrelated_after && response_ok(&repeated_deletion);
    let restart_safe = response_ok(&restart) && after_restart.target_is_absent(ids, &seeded);

    Ok(ScenarioReport {
        details: serde_json::json!({
            "deletion": deletion,
            "after": after,
            "unrelated_after": unrelated_after,
            "repeated_deletion": repeated_deletion,
            "restart": restart,
            "after_restart": after_restart,
        }),
        checks: vec![
            ("fixture has two runs and support rows", fixture_complete),
            ("production receipt has exact session IDs", receipt_exact),
            ("target state is gone", after.target_is_absent(ids, &seeded)),
            ("isolation and idempotency hold", isolation_and_idempotency),
            ("restart does not resurrect target state", restart_safe),
        ],
    })
}

async fn run_rollback_retry_scenario(
    cfg: &Config,
    ids: &FixtureIds,
) -> Result<ScenarioReport, String> {
    let seeded = seed_fixture(cfg, ids).await?;
    let target_session_ids = ids.target_session_ids();
    let target_run_ids = seeded.target_run_ids();
    let unrelated_session_ids = vec![ids.unrelated_root.clone(), ids.unrelated_worker.clone()];
    let unrelated_run_ids = vec![seeded.unrelated_run.clone()];
    let before = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let unrelated_before = snapshot(
        cfg,
        &ids.unrelated_root,
        &unrelated_session_ids,
        &unrelated_run_ids,
    )
    .await?;

    let arm_body = serde_json::json!({ "root_session_id": ids.root });
    let arm = post_json(cfg, FAULT_ARM_PATH, arm_body).await?;
    // The production attempt endpoint deliberately owns no fault-fixture
    // cleanup. Always issue the disarm request after the first attempt, even
    // when the attempt itself returns a transport error.
    let failed_deletion_result = delete_attempt(cfg, &ids.root).await;
    let disarm_result = post_json(cfg, FAULT_DISARM_PATH, serde_json::json!({})).await;
    let failed_deletion = failed_deletion_result?;
    let disarm = disarm_result?;
    let after_failure = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let restart = post_json(cfg, RESTART_PATH, serde_json::json!({})).await?;
    let resume_body = serde_json::json!({ "org_run_id": seeded.live_run });
    let resume = post_json(cfg, RESUME_PATH, resume_body).await?;
    let retry = delete_attempt(cfg, &ids.root).await?;
    let after_retry = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let restart_after_retry = post_json(cfg, RESTART_PATH, serde_json::json!({})).await?;
    let after_restart = snapshot(cfg, &ids.root, &target_session_ids, &target_run_ids).await?;
    let unrelated_after = snapshot(
        cfg,
        &ids.unrelated_root,
        &unrelated_session_ids,
        &unrelated_run_ids,
    )
    .await?;

    let fault_error = !response_ok(&failed_deletion)
        && failed_deletion
            .get("error")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|error| error.contains(DELETE_FAULT_ERROR));
    let durable_rows_rolled_back =
        Snapshot::rows_match(&after_failure.sessions, &target_session_ids, true)
            && Snapshot::rows_match(&after_failure.runs, &target_run_ids, true)
            && after_failure.has_expected_topology(ids, &seeded)
            && before.fence_count == 0
            && before.support_counts == SupportCounts::expected(2, 1)
            && after_failure.fence_count == 1
            && after_failure.support_counts == before.support_counts;
    let run_states_are_safe = after_failure.run_status(&seeded.history_run) == Some("completed")
        && after_failure.run_status(&seeded.live_run) == Some("cancelled");
    let resume_rejected_by_fence = !response_ok(&resume)
        && resume
            .get("error")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|error| error.contains("conversation_deleting"));
    let retry_receipt_exact =
        response_ok(&retry) && receipt_has_exact_ids(&retry, &target_session_ids);
    let restart_is_fenced = response_ok(&restart) && resume_rejected_by_fence;
    let retry_is_complete = retry_receipt_exact
        && after_retry.target_is_absent(ids, &seeded)
        && response_ok(&restart_after_retry)
        && after_restart.target_is_absent(ids, &seeded);

    Ok(ScenarioReport {
        details: serde_json::json!({
            "failed_deletion": failed_deletion,
            "disarm": disarm,
            "after_failure": after_failure,
            "restart": restart,
            "resume": resume,
            "retry": retry,
            "after_retry": after_retry,
            "restart_after_retry": restart_after_retry,
            "after_restart": after_restart,
            "unrelated_after": unrelated_after,
        }),
        checks: vec![
            (
                "fault fires and explicit disarm succeeds",
                response_ok(&arm) && fault_error && response_ok(&disarm),
            ),
            (
                "rollback preserves exact owned rows",
                durable_rows_rolled_back,
            ),
            ("live run remains safely cancelled", run_states_are_safe),
            ("restart keeps resume fenced", restart_is_fenced),
            ("retry removes exact target state", retry_is_complete),
            (
                "unrelated fixture is unchanged",
                unrelated_before == unrelated_after,
            ),
        ],
    })
}

async fn finish_scenario(
    cfg: &Config,
    label: &str,
    ids: &FixtureIds,
    result: Result<ScenarioReport, String>,
) -> bool {
    let cleanup_ok = cleanup_fixture(cfg, ids).await;
    match result {
        Err(error) => {
            let _ = harness::print_error(label, &error);
            false
        }
        Ok(report) => {
            let passed = harness::print_result(label, &report.details.to_string(), &report.checks);
            if !cleanup_ok {
                eprintln!("[{label}] isolated fixture cleanup failed");
            }
            passed && cleanup_ok
        }
    }
}

async fn run_registered(cfg: &Config, label: &str, rollback_retry: bool) -> bool {
    let ids = FixtureIds::new(label);
    let result = if rollback_retry {
        run_rollback_retry_scenario(cfg, &ids).await
    } else {
        run_success_scenario(cfg, &ids).await
    };
    finish_scenario(cfg, &format!("agent-org-{label}"), &ids, result).await
}

pub async fn multi_run_root_delete_production_command(cfg: &Config) -> bool {
    run_registered(cfg, "multi-run-root-delete-production-command", false).await
}

pub async fn multi_run_root_delete_rollback_retry(cfg: &Config) -> bool {
    run_registered(cfg, "multi-run-root-delete-rollback-retry", true).await
}

pub async fn cleanup_fault_fixture(cfg: &Config) -> Result<(), String> {
    let response = post_json(cfg, FAULT_DISARM_PATH, serde_json::json!({})).await?;
    if response_ok(&response) {
        Ok(())
    } else {
        Err(format!("delete fault cleanup failed: {response}"))
    }
}
