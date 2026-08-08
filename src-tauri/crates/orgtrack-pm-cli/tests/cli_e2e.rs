//! Cross-process E2E for the `org2-pm` binary (Phase 3 checklist):
//! the test process seeds the sandbox store through the shared
//! application crates, the real CLI binary mutates it from a separate
//! process, and the parent verifies the durable effects — including the
//! `pm_change_seq` watermark the desktop host polls to notice external
//! writers.

use std::process::Command;

use project_management::projects::io::{write_project, write_work_item};
use project_management::projects::types::{ProjectMeta, WorkItemFrontmatter};
use test_helpers::test_env;

fn project_fixture(id: &str, name: &str) -> ProjectMeta {
    ProjectMeta {
        id: id.to_string(),
        name: name.to_string(),
        org_id: "personal-org".to_string(),
        status: "active".to_string(),
        priority: "none".to_string(),
        health: "no_updates".to_string(),
        lead: None,
        members: vec![],
        labels: vec![],
        linked_repos: vec![],
        start_date: None,
        target_date: None,
        created_at: String::new(),
        updated_at: String::new(),
        next_work_item_id: 1,
        work_item_prefix: "AAA".to_string(),
        work_item_prefix_custom: true,
        agent_defaults: None,
    }
}

fn work_item_fixture(id: &str, short_id: &str, title: &str) -> WorkItemFrontmatter {
    WorkItemFrontmatter {
        id: id.to_string(),
        short_id: short_id.to_string(),
        title: title.to_string(),
        project: None,
        status: "backlog".to_string(),
        priority: "none".to_string(),
        assignee: None,
        assignee_type: None,
        labels: vec![],
        milestone: None,
        parent: None,
        start_date: None,
        target_date: None,
        created_by: None,
        created_at: String::new(),
        updated_at: String::new(),
        deleted_at: None,
        starred: false,
        todos: vec![],
        comments: vec![],
        history: vec![],
        delegations: vec![],
        linked_sessions: vec![],
        handoff: None,
        proof_of_work: None,
        orchestrator_config: None,
        orchestrator_state: None,
        follow_up_items: vec![],
        schedule: None,
        routine_source: None,
        execution_lock: None,
        close_out: None,
        work_products: vec![],
    }
}

fn seed(slug: &str) {
    // The lib's cfg(test) auto-init only fires inside project_management's
    // own unit tests; integration tests initialize the sandbox store the
    // same way the desktop host and the CLI do.
    let connection = database::db::get_projects_connection().expect("projects connection");
    project_management::projects::schema::init_project_tables(&connection).expect("schema");
    drop(connection);
    write_project(slug, &project_fixture("p1", "Demo"), "", true).expect("project");
    write_work_item(
        slug,
        "AAA-0001",
        &work_item_fixture("w1", "AAA-0001", "CLI target"),
        "body",
    )
    .expect("seed work item");
}

fn run_cli(args: &[&str]) -> (i32, serde_json::Value) {
    let exe = env!("CARGO_BIN_EXE_org2-pm");
    let output = Command::new(exe).args(args).output().expect("spawn org2-pm");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap_or_else(|err| {
        panic!(
            "stdout must be exactly one JSON envelope: {err}\nstdout: {stdout}\nstderr: {}",
            String::from_utf8_lossy(&output.stderr)
        )
    });
    (output.status.code().unwrap_or(-1), value)
}

fn change_seq() -> i64 {
    let connection = rusqlite_probe();
    connection
        .query_row("SELECT seq FROM pm_change_seq WHERE id = 1", [], |row| {
            row.get(0)
        })
        .expect("pm_change_seq")
}

fn rusqlite_probe() -> rusqlite::Connection {
    // ORGII_HOME IS the orgii root (no extra `.orgii` segment):
    // projects_db() = <root>/projects/projects.db (app-paths).
    let home = std::env::var("ORGII_HOME").expect("sandbox sets ORGII_HOME");
    let path = std::path::Path::new(&home)
        .join("projects")
        .join("projects.db");
    rusqlite::Connection::open(path).expect("open projects.db")
}

#[test]
fn context_defaults_to_build_with_no_capabilities() {
    let _sandbox = test_env::sandbox();
    let (exit, envelope) = run_cli(&["context"]);
    assert_eq!(exit, 0, "envelope: {envelope}");
    assert_eq!(envelope["ok"], true);
    assert_eq!(envelope["data"]["mode"], "build");
    assert_eq!(envelope["data"]["capabilities"], serde_json::json!([]));
    assert_eq!(envelope["apiVersion"], "orgtrack/v1");
}

#[test]
fn mutations_outside_project_mode_are_gated() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let (exit, envelope) = run_cli(&[
        "work",
        "transition",
        "AAA-0001",
        "--to",
        "completed",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
    ]);
    assert_eq!(exit, 5, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "PROJECT_MODE_REQUIRED");
}

#[test]
fn external_shell_agent_completes_a_work_item_end_to_end() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let seq_before = change_seq();

    let base = [
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
        "--session-ref",
        "claude_code:session_e2e_1",
    ];

    // Discover ready work.
    let (exit, listed) = run_cli(&[&["work", "list", "--ready"], &base[..]].concat());
    assert_eq!(exit, 0, "list envelope: {listed}");
    assert_eq!(listed["data"]["items"][0]["frontmatter"]["short_id"], "AAA-0001");

    // Claim: lock + strict open -> in_progress.
    let (exit, claimed) = run_cli(&[&["work", "claim", "AAA-0001"], &base[..]].concat());
    assert_eq!(exit, 0, "claim envelope: {claimed}");
    assert_eq!(claimed["data"]["frontmatter"]["status"], "in_progress");
    assert_eq!(
        claimed["data"]["frontmatter"]["execution_lock"]["activeSessionId"],
        "session_e2e_1"
    );

    // Progress note.
    let (exit, noted) = run_cli(
        &[
            &["work", "note", "AAA-0001", "--kind", "progress", "--body", "half way"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "note envelope: {noted}");

    // Relate an external session.
    let (exit, related) = run_cli(
        &[
            &[
                "work",
                "relate",
                "AAA-0001",
                "--type",
                "participated_in",
                "--target",
                "session://claude_code/session_e2e_1",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "relate envelope: {related}");

    // Complete.
    let (exit, done) = run_cli(
        &[
            &["work", "transition", "AAA-0001", "--to", "completed", "--reason", "done"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "transition envelope: {done}");
    assert_eq!(done["data"]["frontmatter"]["status"], "completed");
    assert_eq!(done["data"]["portableState"], "completed");

    // Cross-process watermark: the desktop host notices external writers
    // through pm_change_seq alone.
    let seq_after = change_seq();
    assert!(
        seq_after >= seq_before + 4,
        "each CLI mutation bumps the watermark ({seq_before} -> {seq_after})"
    );

    // Audit trail carries the canonical operations.
    let connection = rusqlite_probe();
    let operations: Vec<String> = connection
        .prepare("SELECT operation FROM pm_audit_events ORDER BY id")
        .expect("prepare")
        .query_map([], |row| row.get(0))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    for expected in ["work.claim", "work.note", "work.relate", "work.transition"] {
        assert!(
            operations.iter().any(|op| op == expected),
            "audit stream must contain {expected}; got {operations:?}"
        );
    }

    // show returns the relation and an OCC revision.
    let (exit, shown) = run_cli(&[&["work", "show", "AAA-0001"], &base[..]].concat());
    assert_eq!(exit, 0, "show envelope: {shown}");
    assert!(shown["data"]["revision"].as_i64().unwrap_or(0) >= 2);
    assert_eq!(shown["data"]["relations"][0]["kind"], "participated_in");
}

#[test]
fn idempotency_replays_and_conflicts() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let base = [
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
        "--session-ref",
        "claude_code:session_idem",
    ];

    let claim_args = [
        &["work", "claim", "AAA-0001", "--idempotency-key", "sess:claim"],
        &base[..],
    ]
    .concat();
    let (exit, first) = run_cli(&claim_args);
    assert_eq!(exit, 0, "first claim: {first}");
    assert_eq!(first["data"]["frontmatter"]["status"], "in_progress");

    // Exact replay: returns the stored response instead of re-executing
    // (a re-run would fail INVALID_TRANSITION — already in_progress).
    let (exit, replay) = run_cli(&claim_args);
    assert_eq!(exit, 0, "replayed claim: {replay}");
    assert_eq!(replay["data"]["frontmatter"]["status"], "in_progress");

    let (exit, done) = run_cli(
        &[
            &[
                "work",
                "transition",
                "AAA-0001",
                "--to",
                "completed",
                "--idempotency-key",
                "sess:finish",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "transition: {done}");

    // Same key, different canonical request -> conflict.
    let (exit, conflict) = run_cli(
        &[
            &[
                "work",
                "transition",
                "AAA-0001",
                "--to",
                "open",
                "--idempotency-key",
                "sess:finish",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 4, "conflict: {conflict}");
    assert_eq!(conflict["error"]["code"], "IDEMPOTENCY_CONFLICT");
}

#[test]
fn routine_lifecycle_runs_through_the_cli() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../docs/orgtrack-pm-protocol/fixtures/routine-spec.json");
    let fixture_arg = fixture_path.to_string_lossy().to_string();
    let base = [
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
        "--session-ref",
        "claude_code:session_routine",
    ];

    // validate + apply (idempotent revision).
    let (exit, validated) =
        run_cli(&[&["routine", "validate", "--file", &fixture_arg], &base[..]].concat());
    assert_eq!(exit, 0, "validate: {validated}");
    let (exit, applied) =
        run_cli(&[&["routine", "apply", "--file", &fixture_arg], &base[..]].concat());
    assert_eq!(exit, 0, "apply: {applied}");
    assert_eq!(applied["data"]["revision"], 1);
    let (exit, reapplied) =
        run_cli(&[&["routine", "apply", "--file", &fixture_arg], &base[..]].concat());
    assert_eq!(exit, 0, "re-apply: {reapplied}");
    assert_eq!(reapplied["data"]["revision"], 1, "same body keeps revision");

    // run with inputs -> materialized graph.
    let (exit, run) = run_cli(
        &[
            &[
                "routine",
                "run",
                "interaction-impact-analysis",
                "--input",
                "requirement_id=REQ-042",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "run: {run}");
    let run_id = run["data"]["runId"].as_str().expect("runId").to_string();
    assert_eq!(run["data"]["steps"].as_array().map(Vec::len), Some(3));

    // status: running; the dependent steps are open, the first is ready.
    let (exit, status) = run_cli(&[&["routine", "status", &run_id], &base[..]].concat());
    assert_eq!(exit, 0, "status: {status}");
    assert_eq!(status["data"]["status"], "running");

    // Complete the first step through the portable lifecycle.
    let first_step = run["data"]["steps"][0]["workItemId"]
        .as_str()
        .expect("step id")
        .to_string();
    let (exit, claimed) = run_cli(&[&["work", "claim", &first_step], &base[..]].concat());
    assert_eq!(exit, 0, "claim: {claimed}");
    let (exit, done) = run_cli(
        &[
            &["work", "transition", &first_step, "--to", "completed"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "transition: {done}");

    // Projection stays running (downstream became ready), and the step
    // shows completed in the durable view.
    let (exit, status) = run_cli(&[&["routine", "status", &run_id], &base[..]].concat());
    assert_eq!(exit, 0, "status after completion: {status}");
    assert_eq!(status["data"]["status"], "running");
    let items = status["data"]["workItems"].as_array().expect("workItems");
    let first = items
        .iter()
        .find(|item| item["shortId"] == first_step.as_str())
        .expect("first step in view");
    assert_eq!(first["portableState"], "completed");
}

#[test]
fn wire_validation_maps_to_stable_codes() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let base = [
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
    ];

    let (exit, envelope) = run_cli(
        &[&["work", "transition", "AAA-0001", "--to", "done"], &base[..]].concat(),
    );
    assert_eq!(exit, 2, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGUMENT");

    let (exit, envelope) =
        run_cli(&[&["work", "show", "AAA-9999"], &base[..]].concat());
    assert_eq!(exit, 3, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "NOT_FOUND");

    // in_progress is claim-only.
    let (exit, envelope) = run_cli(
        &[
            &["work", "transition", "AAA-0001", "--to", "in_progress"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 4, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "INVALID_TRANSITION");

    // Hook short names are not canonical provider ids (decisions §5).
    let (exit, envelope) = run_cli(
        &[
            &[
                "work",
                "claim",
                "AAA-0001",
                "--session-ref",
                "claude:session_x",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 2, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGUMENT");
    assert!(
        envelope["error"]["message"]
            .as_str()
            .unwrap_or_default()
            .contains("claude_code"),
        "message points at the canonical id: {envelope}"
    );
}
