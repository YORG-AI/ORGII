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
        stage: None,
        start_date: None,
        target_date: None,
        created_by: None,
        origin_session: None,
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
    let home = std::env::var_os("ORGII_HOME").expect("sandbox sets ORGII_HOME");
    let output = Command::new(exe)
        .args(args)
        .current_dir(home)
        .output()
        .expect("spawn org2-pm");
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
fn work_create_captures_origin_session_without_faking_an_execution_link() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let (exit, created) = run_cli(&[
        "work",
        "create",
        "--title",
        "Created from agent turn",
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:sde",
        "--session-ref",
        "org2:sdeagent-origin-1",
    ]);
    assert_eq!(exit, 0, "create envelope: {created}");
    let frontmatter = &created["data"]["frontmatter"];
    assert_eq!(
        frontmatter["origin_session"]["session_id"],
        "sdeagent-origin-1"
    );
    assert_eq!(frontmatter["origin_session"]["provider"], "org2");
    assert_eq!(frontmatter["origin_session"]["actor_id"], "agent:sde");
    assert_eq!(frontmatter["origin_session"]["session_type"], "native");
    assert!(
        frontmatter.get("linked_sessions").is_none()
            || frontmatter["linked_sessions"]
                .as_array()
                .is_some_and(Vec::is_empty),
        "origin provenance must not create an execution link: {frontmatter}"
    );

    let short_id = frontmatter["short_id"].as_str().expect("short id");
    let (exit, shown) = run_cli(&[
        "work",
        "show",
        short_id,
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:sde",
        "--session-ref",
        "org2:sdeagent-origin-1",
    ]);
    assert_eq!(exit, 0, "show envelope: {shown}");
    assert_eq!(
        shown["data"]["frontmatter"]["origin_session"]["session_id"],
        "sdeagent-origin-1"
    );
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
    assert_eq!(
        listed["data"]["items"][0]["frontmatter"]["short_id"],
        "AAA-0001"
    );

    // Claim with the observed revision: lock + strict open -> in_progress
    // and the OCC precondition hold in ONE transaction.
    let shown_revision = {
        let (exit, shown) = run_cli(&[&["work", "show", "AAA-0001"], &base[..]].concat());
        assert_eq!(exit, 0, "show envelope: {shown}");
        shown["data"]["revision"].as_i64().expect("revision")
    };
    let revision_flag = shown_revision.to_string();
    let (exit, claimed) = run_cli(
        &[
            &[
                "work",
                "claim",
                "AAA-0001",
                "--expected-revision",
                &revision_flag,
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "claim envelope: {claimed}");
    assert_eq!(claimed["data"]["frontmatter"]["status"], "in_progress");
    assert_eq!(
        claimed["data"]["frontmatter"]["execution_lock"]["activeSessionId"],
        "session_e2e_1"
    );

    // Progress note.
    let (exit, noted) = run_cli(
        &[
            &[
                "work", "note", "AAA-0001", "--kind", "progress", "--body", "half way",
            ],
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
            &[
                "work",
                "transition",
                "AAA-0001",
                "--to",
                "completed",
                "--reason",
                "done",
            ],
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
        &[
            "work",
            "claim",
            "AAA-0001",
            "--idempotency-key",
            "sess:claim",
        ],
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
        &[
            &["work", "transition", "AAA-0001", "--to", "done"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 2, "envelope: {envelope}");
    assert_eq!(envelope["error"]["code"], "INVALID_ARGUMENT");

    let (exit, envelope) = run_cli(&[&["work", "show", "AAA-9999"], &base[..]].concat());
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

#[test]
fn assign_release_pagination_and_portable_filter() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    for n in 2..=4 {
        let short_id = format!("AAA-000{n}");
        write_work_item(
            "demo",
            &short_id,
            &work_item_fixture(&short_id, &short_id, &format!("Item {n}")),
            "body",
        )
        .expect("seed extra item");
    }
    let base = [
        "--mode",
        "project",
        "--scope",
        "demo",
        "--actor",
        "agent:cli-tester",
        "--session-ref",
        "claude_code:session_e2e_2",
    ];

    let (exit, page1) = run_cli(
        &[
            &["work", "list", "--status", "open", "--limit", "2"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{page1}");
    assert_eq!(page1["data"]["items"].as_array().expect("items").len(), 2);
    let cursor = page1["meta"]["nextCursor"]
        .as_str()
        .expect("nextCursor")
        .to_string();

    let (exit, page2) = run_cli(
        &[
            &[
                "work", "list", "--status", "open", "--limit", "2", "--cursor", &cursor,
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{page2}");
    assert_eq!(page2["data"]["items"].as_array().expect("items").len(), 2);
    assert!(page2["meta"].get("nextCursor").is_none(), "{page2}");
    assert_ne!(
        page1["data"]["items"][0]["frontmatter"]["short_id"],
        page2["data"]["items"][0]["frontmatter"]["short_id"]
    );

    let (exit, bad) = run_cli(&[&["work", "list", "--status", "backlog"], &base[..]].concat());
    assert_eq!(exit, 2, "legacy vocabulary is rejected: {bad}");
    assert_eq!(bad["error"]["code"], "INVALID_ARGUMENT");

    let (exit, assigned) = run_cli(
        &[
            &[
                "work",
                "assign",
                "AAA-0002",
                "--assignee",
                "agent:builtin-os",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{assigned}");
    assert_eq!(assigned["data"]["frontmatter"]["assignee"], "builtin-os");
    assert_eq!(assigned["data"]["frontmatter"]["assignee_type"], "agent");

    let (exit, claimed) = run_cli(&[&["work", "claim", "AAA-0002"], &base[..]].concat());
    assert_eq!(exit, 0, "{claimed}");

    let (exit, released) = run_cli(&[&["work", "release", "AAA-0002"], &base[..]].concat());
    assert_eq!(exit, 0, "{released}");
    assert_eq!(released["data"]["frontmatter"]["status"], "open");
    assert!(
        released["data"]["frontmatter"]["execution_lock"].is_null(),
        "{released}"
    );

    let (exit, foreign) = run_cli(
        &[
            &["work", "claim", "AAA-0002"],
            &base[..8],
            &["--session-ref", "claude_code:session_e2e_other"][..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{foreign}");
    let (exit, denied) = run_cli(&[&["work", "release", "AAA-0002"], &base[..]].concat());
    assert_eq!(exit, 4, "release by non-holder must fail: {denied}");
    assert_eq!(denied["error"]["code"], "ALREADY_CLAIMED");

    let (exit, foreign_update) = run_cli(
        &[
            &["work", "update", "AAA-0002", "--title", "hijack"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(
        exit, 4,
        "update on a foreign-claimed item must fail: {foreign_update}"
    );
    assert_eq!(foreign_update["error"]["code"], "ALREADY_CLAIMED");

    let (exit, foreign_transition) = run_cli(
        &[
            &["work", "transition", "AAA-0002", "--to", "completed"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(
        exit, 4,
        "transition on a foreign-claimed item must fail: {foreign_transition}"
    );
    assert_eq!(foreign_transition["error"]["code"], "ALREADY_CLAIMED");
}

#[test]
fn project_family_creates_reads_and_updates_through_the_boundary() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let base = ["--mode", "project", "--actor", "human:vince"];

    let (exit, created) = run_cli(
        &[
            &[
                "project",
                "create",
                "--name",
                "Dog Walker MVP",
                "--description",
                "walkies",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{created}");
    assert_eq!(created["data"]["slug"], "dog-walker-mvp");
    assert_eq!(created["data"]["orgId"], "personal-org");

    let (exit, dup) = run_cli(
        &[
            &["project", "create", "--name", "Dog Walker MVP"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 4, "duplicate slug must refuse: {dup}");
    assert_eq!(dup["error"]["code"], "ALREADY_EXISTS");

    let (exit, shown) = run_cli(&["project", "show", "dog-walker-mvp"]);
    assert_eq!(exit, 0, "{shown}");
    assert_eq!(shown["data"]["description"], "walkies");

    let (exit, updated) = run_cli(
        &[
            &["project", "update", "dog-walker-mvp", "--status", "active"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "{updated}");
    assert_eq!(updated["data"]["status"], "active");

    let (exit, found) = run_cli(&["project", "find", "dog"]);
    assert_eq!(exit, 0, "{found}");
    assert_eq!(found["data"]["items"].as_array().expect("items").len(), 1);

    let (exit, gated) = run_cli(&["project", "create", "--name", "Nope"]);
    assert_eq!(exit, 5, "mutation outside project mode: {gated}");
}

#[test]
fn session_marker_locks_identity_fail_closed() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let home = std::env::var("ORGII_HOME").expect("sandbox sets ORGII_HOME");
    let workspace = std::path::Path::new(&home).join("marker-workspace");
    std::fs::create_dir_all(workspace.join(".orgii")).expect("workspace dirs");
    std::fs::write(
        workspace.join(".orgii/agent_session_context.json"),
        serde_json::json!({
            "apiVersion": "orgtrack/v1",
            "sessionRef": "org2:session_marker_1",
            "actor": "agent:os",
            "productMode": "project",
            "scope": "demo",
            "capabilities": ["work.read", "work.mutate"],
            "issuedAt": "2026-08-07T00:00:00Z",
        })
        .to_string(),
    )
    .expect("marker written");

    let run_in_workspace = |args: &[&str]| {
        let exe = env!("CARGO_BIN_EXE_org2-pm");
        let output = Command::new(exe)
            .args(args)
            .current_dir(&workspace)
            .output()
            .expect("spawn org2-pm");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let value: serde_json::Value =
            serde_json::from_str(stdout.trim()).unwrap_or_else(|err| panic!("{stdout}: {err}"));
        (output.status.code().unwrap_or(-1), value)
    };

    let (exit, context) = run_in_workspace(&["context"]);
    assert_eq!(exit, 0, "{context}");
    assert_eq!(context["data"]["mode"], "project");
    assert_eq!(context["data"]["scopeId"], "demo");
    assert_eq!(context["data"]["actor"]["kind"], "agent");
    assert_eq!(context["data"]["actor"]["id"], "os");

    let (exit, created) = run_in_workspace(&["work", "create", "--title", "marker item"]);
    assert_eq!(exit, 0, "identity injected from the marker: {created}");

    let (exit, denied) = run_in_workspace(&[
        "work",
        "create",
        "--title",
        "spoof",
        "--actor",
        "human:vince",
    ]);
    assert_eq!(exit, 8, "actor spoofing must be refused: {denied}");
    assert_eq!(denied["error"]["code"], "PERMISSION_DENIED");

    let (exit, foreign) = run_in_workspace(&[
        "work",
        "claim",
        "AAA-0001",
        "--session-ref",
        "claude_code:other",
    ]);
    assert_eq!(exit, 8, "session override must be refused: {foreign}");
}

#[test]
fn build_marker_cannot_be_elevated_by_mode_flag_even_with_project_scope() {
    let _sandbox = test_env::sandbox();
    seed("demo");
    let home = std::env::var("ORGII_HOME").expect("sandbox sets ORGII_HOME");
    let workspace = std::path::Path::new(&home).join("build-marker-workspace");
    std::fs::create_dir_all(workspace.join(".orgii")).expect("workspace dirs");
    std::fs::write(
        workspace.join(".orgii/agent_session_context.json"),
        serde_json::json!({
            "apiVersion": "orgtrack/v1",
            "sessionRef": "org2:ordinary_build_session",
            "actor": "agent:sde",
            "productMode": "build",
            "scope": "demo",
            "capabilities": ["work.read"],
            "issuedAt": "2026-08-09T00:00:00Z",
        })
        .to_string(),
    )
    .expect("marker written");

    let output = Command::new(env!("CARGO_BIN_EXE_org2-pm"))
        .args([
            "work",
            "create",
            "--title",
            "must stay denied",
            "--mode",
            "project",
        ])
        .current_dir(&workspace)
        .output()
        .expect("spawn org2-pm");
    let denied: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("parse denied response");
    assert_eq!(output.status.code(), Some(5), "{denied}");
    assert_eq!(denied["error"]["code"], "PROJECT_MODE_REQUIRED");
    assert_eq!(denied["error"]["details"]["currentMode"], "build");
}

#[test]
fn standalone_items_are_reachable_without_scope() {
    let _sandbox = test_env::sandbox();
    let connection = database::db::get_projects_connection().expect("projects connection");
    project_management::projects::schema::init_project_tables(&connection).expect("schema");
    drop(connection);

    let fixture = work_item_fixture("s1", "STA-0001", "Standalone draft");
    project_management::projects::io::write_standalone_work_item(
        None,
        "STA-0001",
        &fixture,
        "draft body",
    )
    .expect("seed standalone");

    let base = [
        "--mode",
        "project",
        "--actor",
        "agent:cli-tester",
        "--session-ref",
        "claude_code:session_e2e_sta",
    ];

    // A bare id with no resolvable project scope routes to the org's
    // standalone store — a session bound to a standalone root item can
    // address it without knowing the `--standalone` flag (the Discussion
    // forward and delivery-mandate instructions all use bare ids).
    let (exit, bare) = run_cli(&[&["work", "show", "STA-0001"], &base[..]].concat());
    assert_eq!(exit, 0, "scope-less bare-id show: {bare}");
    assert_eq!(bare["data"]["frontmatter"]["short_id"], "STA-0001");

    let (exit, bare_noted) = run_cli(
        &[
            &[
                "work",
                "note",
                "STA-0001",
                "--kind",
                "comment",
                "--body",
                "bare-id receipt",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "scope-less bare-id note: {bare_noted}");

    // Stage round-trips through create and update (barrier grouping).
    let (exit, staged) = run_cli(
        &[
            &[
                "work",
                "create",
                "--standalone",
                "--title",
                "Staged child",
                "--parent",
                "STA-0001",
                "--stage",
                "2",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "staged create: {staged}");
    assert_eq!(staged["data"]["frontmatter"]["stage"], 2);
    let staged_id = staged["data"]["frontmatter"]["short_id"]
        .as_str()
        .expect("short id")
        .to_string();
    let (exit, restaged) =
        run_cli(&[&["work", "update", &staged_id, "--stage", "1"], &base[..]].concat());
    assert_eq!(exit, 0, "stage update: {restaged}");
    assert_eq!(restaged["data"]["frontmatter"]["stage"], 1);

    // The full lifecycle works on bare ids too: claim enters
    // in_progress, transition completes — the path an agent takes to
    // finish a standalone sub-item (which closes the parent barrier).
    let (exit, claimed) = run_cli(&[&["work", "claim", "STA-0001"], &base[..]].concat());
    assert_eq!(exit, 0, "scope-less bare-id claim: {claimed}");
    assert_eq!(claimed["data"]["frontmatter"]["status"], "in_progress");
    let (exit, done) = run_cli(
        &[
            &["work", "transition", "STA-0001", "--to", "completed"],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "scope-less bare-id transition: {done}");
    assert_eq!(done["data"]["frontmatter"]["status"], "completed");

    // `--standalone` routes to the org-scoped store without any scope.
    let (exit, shown) =
        run_cli(&[&["work", "show", "STA-0001", "--standalone"], &base[..]].concat());
    assert_eq!(exit, 0, "show envelope: {shown}");
    assert_eq!(shown["data"]["frontmatter"]["short_id"], "STA-0001");

    let (exit, listed) = run_cli(&[&["work", "list"], &base[..]].concat());
    assert_eq!(exit, 0, "list envelope: {listed}");
    assert_eq!(
        listed["data"]["items"][0]["frontmatter"]["short_id"],
        "STA-0001"
    );

    // Progress note lands in the standalone item's comment thread.
    let (exit, noted) = run_cli(
        &[
            &[
                "work",
                "note",
                "STA-0001",
                "--standalone",
                "--kind",
                "progress",
                "--body",
                "half way",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "note envelope: {noted}");
    let item = project_management::projects::io::read_standalone_work_item(None, "STA-0001")
        .expect("noted read back");
    assert!(
        item.frontmatter
            .comments
            .iter()
            .any(|comment| comment.content == "[progress] half way"
                && comment.author == "cli-tester"),
        "note must land in comments: {:?}",
        item.frontmatter.comments
    );

    // `--body-file` sidesteps shell quoting for agent-authored bodies.
    let body_path = std::env::temp_dir().join("orgii-cli-e2e-body.md");
    std::fs::write(&body_path, "literal `backticks` and $(no expansion)").expect("write body file");
    let body_path_str = body_path.to_string_lossy().to_string();
    let (exit, filed) = run_cli(
        &[
            &[
                "work",
                "update",
                "STA-0001",
                "--standalone",
                "--body-file",
                &body_path_str,
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "body-file envelope: {filed}");
    assert_eq!(
        filed["data"]["body"],
        "literal `backticks` and $(no expansion)"
    );

    // A sub item created with --parent records the parent linkage.
    let (exit, child) = run_cli(
        &[
            &[
                "work",
                "create",
                "--standalone",
                "--title",
                "Child task",
                "--parent",
                "STA-0001",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "child envelope: {child}");
    assert_eq!(child["data"]["frontmatter"]["parent"], "STA-0001");

    // Fill the draft the way the AI work-item filler does.
    let (exit, updated) = run_cli(
        &[
            &[
                "work",
                "update",
                "STA-0001",
                "--standalone",
                "--title",
                "Filled title",
                "--body",
                "Filled body",
            ],
            &base[..],
        ]
        .concat(),
    );
    assert_eq!(exit, 0, "update envelope: {updated}");
    assert_eq!(updated["data"]["frontmatter"]["title"], "Filled title");

    let item = project_management::projects::io::read_standalone_work_item(None, "STA-0001")
        .expect("read back");
    assert_eq!(item.frontmatter.title, "Filled title");
    assert_eq!(item.body, "Filled body");

    // With no project scope, create automatically targets the current org's
    // standalone store. The model must not need a magic flag or ask the user
    // to invent a Project.
    let (exit, created) =
        run_cli(&[&["work", "create", "--title", "Another one"], &base[..]].concat());
    assert_eq!(exit, 0, "create envelope: {created}");
    let new_id = created["data"]["frontmatter"]["short_id"]
        .as_str()
        .expect("short id")
        .to_string();
    assert_ne!(new_id, "STA-0001");
    let item = project_management::projects::io::read_standalone_work_item(None, &new_id)
        .expect("created read back");
    assert_eq!(item.frontmatter.title, "Another one");
}
