//! Tests for the unified agent tool — delegation scoping, session id shape,
//! subagent-of-subagent guard, regression pins.
//!
//! Kept intentionally narrow: only behavior that would regress silently
//! if the production code changed. Schema-shape and JSON-parsing smoke
//! tests were removed — they exercised locally-constructed fakes rather
//! than production code.

use super::helpers::{
    looks_like_valid_subagent_session_id, optional_nonempty_string_param,
    org_roster_spawn_rejection, subagent_of_subagent_rejection, subagent_type, subagent_type_label,
};
use super::resolve_agent_id_for_execute;
use crate::coordination::agent_org_runs::{AgentOrgContextMember, AgentOrgRunContext};
use crate::definitions::builtin::{EXPLORE_AGENT_ID, GENERAL_AGENT_ID};
use crate::tools::traits::ToolError;

fn resolve_session_id(resume: Option<String>, prefix: &str, agent_id: &str) -> String {
    resume.unwrap_or_else(|| format!("{}-{}-{}", prefix, agent_id, uuid::Uuid::new_v4()))
}

fn is_blocked_by_allowlist(allowed: &Option<Vec<String>>, agent_id: &str) -> bool {
    match allowed {
        Some(list) => !list.iter().any(|id| id == agent_id),
        None => false,
    }
}

// ── Subagent type label ─────────────────────────────────────────────

#[test]
fn test_subagent_type_label() {
    assert_eq!(
        subagent_type_label(EXPLORE_AGENT_ID),
        subagent_type::EXPLORE
    );
    assert_eq!(
        subagent_type_label(GENERAL_AGENT_ID),
        subagent_type::GENERAL_PURPOSE
    );
    assert_eq!(
        subagent_type_label("my-custom-agent"),
        subagent_type::CUSTOM
    );
}

// ── Session id construction ─────────────────────────────────────────

#[test]
fn test_subagent_session_id_reuses_resume_id() {
    let result = resolve_session_id(
        Some("prev-session-42".to_string()),
        "agent",
        "builtin:general",
    );
    assert_eq!(result, "prev-session-42");
}

#[test]
fn test_delegate_session_id_prefix() {
    let result = resolve_session_id(None, "agent", "builtin:explore");
    assert!(result.starts_with("agent-builtin:explore-"));
}

#[test]
fn test_shadow_session_id_prefix() {
    let result = resolve_session_id(None, "shadow", "builtin:general");
    assert!(result.starts_with("shadow-builtin:general-"));
}

// ── Delegation scoping (allowlist) ──────────────────────────────────

#[test]
fn test_allowlist_none_permits_all() {
    let allowed: Option<Vec<String>> = None;
    assert!(!is_blocked_by_allowlist(&allowed, "builtin:explore"));
    assert!(!is_blocked_by_allowlist(&allowed, "custom:foo"));
}

#[test]
fn test_allowlist_some_blocks_others() {
    let allowed = Some(vec![
        "builtin:explore".to_string(),
        "builtin:general".to_string(),
    ]);
    assert!(!is_blocked_by_allowlist(&allowed, "builtin:explore"));
    assert!(!is_blocked_by_allowlist(&allowed, "builtin:general"));
    assert!(is_blocked_by_allowlist(
        &allowed,
        "builtin:memory-specialist"
    ));
    assert!(is_blocked_by_allowlist(&allowed, "custom:unrelated"));
}

#[test]
fn test_allowlist_empty_blocks_everything() {
    let allowed = Some(Vec::<String>::new());
    assert!(is_blocked_by_allowlist(&allowed, "builtin:explore"));
    assert!(is_blocked_by_allowlist(&allowed, "custom:foo"));
}

// NOTE: there is no same-id circular detection test because same-id
// parallel spawns at the root session are explicitly allowed. Two
// concurrent `builtin:explore` workers in one turn is a legal
// parallel-research pattern, not a cycle. The `subagent_of_subagent`
// guard below is the only structural check.

// ── llm_description / llm_visible_agent_ids filtering ──────────────

#[test]
fn test_llm_visible_allowlist_keeps_runtime_primitives() {
    use super::schema::llm_visible_agent_ids;

    let allowlist = Some(vec!["custom:helper".to_string()]);
    let visible = llm_visible_agent_ids(allowlist.as_ref());

    assert!(visible.iter().any(|id| id == "builtin:explore"));
    assert!(visible.iter().any(|id| id == "builtin:general"));
}

#[test]
fn test_llm_visible_no_allowlist_shows_secondary_only() {
    use super::schema::llm_visible_agent_ids;

    let visible = llm_visible_agent_ids(None);

    // Default-surface (Secondary, delegatable) builtins are visible.
    assert!(visible.iter().any(|id| id == "builtin:explore"));
    assert!(visible.iter().any(|id| id == "builtin:general"));
    // Primary builtins do NOT surface by default — only when allowlisted.
    assert!(!visible.iter().any(|id| id == "builtin:os"));
    assert!(!visible.iter().any(|id| id == "builtin:sde"));
    assert!(!visible.iter().any(|id| id == "builtin:wingman"));
    // Non-existent ids of course not present.
    assert!(!visible.iter().any(|id| id == "builtin:memory-specialist"));
}

#[test]
fn test_llm_visible_empty_allowlist_keeps_only_runtime_primitives() {
    use super::schema::llm_visible_agent_ids;
    use crate::definitions::builtin::{EXPLORE_AGENT_ID, GENERAL_AGENT_ID};

    let allowlist = Some(Vec::new());
    let visible = llm_visible_agent_ids(allowlist.as_ref());

    assert_eq!(visible, vec![EXPLORE_AGENT_ID, GENERAL_AGENT_ID]);
}

#[test]
fn test_llm_visible_primary_surfaces_only_when_allowlisted() {
    use super::schema::llm_visible_agent_ids;

    // OS Agent ships with `builtin:sde` in its allowlist (see
    // `definitions/builtin/os.rs`). With that allowlist, SDE — a
    // Primary-tier builtin — must surface as a delegation target,
    // matching the runtime guarantee that the parent's `sub_agents`
    // list controls what the LLM sees.
    let allowlist = Some(vec!["builtin:sde".to_string()]);
    let visible = llm_visible_agent_ids(allowlist.as_ref());

    assert!(
        visible.iter().any(|id| id == "builtin:sde"),
        "Primary `builtin:sde` must be visible when explicitly allowlisted; got {visible:?}"
    );
    // Runtime primitives remain available even when the user-configurable
    // allowlist is explicit; the frontend filters them out of pickers, so
    // runtime must own their availability.
    assert!(visible.iter().any(|id| id == "builtin:explore"));
    assert!(visible.iter().any(|id| id == "builtin:general"));
}

#[test]
fn test_llm_visible_primary_blocked_when_not_allowlisted() {
    use super::schema::llm_visible_agent_ids;

    let allowlist = Some(vec!["builtin:does-not-exist".to_string()]);
    let visible = llm_visible_agent_ids(allowlist.as_ref());

    assert!(!visible.iter().any(|id| id == "builtin:os"));
    assert!(!visible.iter().any(|id| id == "builtin:sde"));
    assert!(!visible.iter().any(|id| id == "builtin:wingman"));
    assert!(visible.iter().any(|id| id == "builtin:explore"));
    assert!(visible.iter().any(|id| id == "builtin:general"));
}

#[test]
fn test_fresh_registry_management_tools_require_management_capability() {
    use super::policy::agent_supports_builtin_tool;
    use crate::definitions::capabilities::{CapabilitySet, ManagementCapability};
    use crate::definitions::{AgentDefinition, AgentToolSelection};
    use crate::tools::names as tool_names;

    let agent_without_management = AgentDefinition {
        id: "custom:no-management".to_string(),
        tools: AgentToolSelection {
            system_restrict_to_tools: Some(vec![tool_names::MANAGE_PROJECT.to_string()]),
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(!agent_supports_builtin_tool(
        &agent_without_management,
        tool_names::MANAGE_PROJECT
    ));

    let agent_with_management = AgentDefinition {
        id: "custom:with-management".to_string(),
        capabilities: Some(CapabilitySet {
            management: Some(ManagementCapability {}),
            ..Default::default()
        }),
        tools: AgentToolSelection {
            system_restrict_to_tools: Some(vec![tool_names::MANAGE_PROJECT.to_string()]),
            ..Default::default()
        },
        ..Default::default()
    };
    assert!(agent_supports_builtin_tool(
        &agent_with_management,
        tool_names::MANAGE_PROJECT
    ));
}

// ── Parent exec-mode overlay on worker policies ─────────────────────
//
// The worker policy is built from the parent's BASE policy (captured at
// init, no per-turn exec-mode layer). `overlay_parent_exec_mode` must
// re-apply the parent's CURRENT mode so a Plan-mode parent cannot
// escape its read-only guarantee through `builtin:general`.

#[test]
fn plan_mode_parent_overlay_makes_worker_policy_read_only() {
    use super::AgentTool;
    use crate::session::AgentExecMode;
    use crate::tools::policy::ResolvedToolPolicy;

    let overlaid = AgentTool::overlay_parent_exec_mode(
        ResolvedToolPolicy::permissive(),
        Some(AgentExecMode::Plan),
    );
    for denied in ["edit_file", "run_shell", "apply_patch", "delete_file"] {
        assert!(
            !overlaid.is_allowed(denied),
            "Plan-mode parent must deny {denied} for workers"
        );
    }
    assert!(
        !overlaid.is_allowed("mcp__github__create_issue"),
        "Plan-mode parent must deny side-effecting MCP tools for workers"
    );
    assert!(
        overlaid.is_allowed("read_file"),
        "read tools must survive the overlay"
    );
}

#[test]
fn build_or_absent_parent_mode_leaves_worker_policy_untouched() {
    use super::AgentTool;
    use crate::session::AgentExecMode;
    use crate::tools::policy::ResolvedToolPolicy;

    let build = AgentTool::overlay_parent_exec_mode(
        ResolvedToolPolicy::permissive(),
        Some(AgentExecMode::Build),
    );
    assert!(
        build.is_allowed("edit_file"),
        "Build-mode parent keeps write tools for workers"
    );

    let absent = AgentTool::overlay_parent_exec_mode(ResolvedToolPolicy::permissive(), None);
    assert!(
        absent.is_allowed("edit_file"),
        "no parent mode => no overlay"
    );
}

// ── Default sub_agents on root agents ───────────────────────────────

#[test]
fn test_os_agent_default_sub_agents_are_user_configurable_specialists_only() {
    use crate::definitions::builtin::{get_builtin_agent, OS_AGENT_ID, SDE_AGENT_ID};

    let os = get_builtin_agent(OS_AGENT_ID).expect("OS agent must exist");
    let subs = os
        .sub_agents
        .as_ref()
        .expect("OS agent should have default sub_agents");
    let ids: Vec<&str> = subs
        .iter()
        .map(|sub_agent| sub_agent.agent_id.as_str())
        .collect();
    assert!(ids.contains(&SDE_AGENT_ID));
    assert!(!ids.contains(&"builtin:explore"));
    assert!(!ids.contains(&"builtin:general"));
}

#[test]
fn test_sde_agent_does_not_list_runtime_primitives_as_sub_agents() {
    use crate::definitions::builtin::{get_builtin_agent, SDE_AGENT_ID};

    let sde = get_builtin_agent(SDE_AGENT_ID).expect("SDE agent must exist");
    let ids: Vec<&str> = sde
        .sub_agents
        .as_ref()
        .map(|sub_agents| {
            sub_agents
                .iter()
                .map(|sub_agent| sub_agent.agent_id.as_str())
                .collect()
        })
        .unwrap_or_default();
    assert!(!ids.contains(&"builtin:explore"));
    assert!(!ids.contains(&"builtin:general"));
}

// ── Regression pins for known dispatch errors (2026-04-13) ──────────
//
// 1) "Invalid parameters: missing 'agent_id' (required for delegate mode)"
//    → fixed by falling back to `builtin:general` instead of rejecting.
// 2) "Executor failed: No persisted history found for session '<id>'"
//    → fixed by shape-checking `resume_session_id` before hitting
//      `load_llm_history`.

#[test]
fn regression_delegate_mode_missing_agent_id_now_falls_back() {
    let params = serde_json::json!({
        "prompt": "Explore tauri architecture",
    });

    let resolved = resolve_agent_id_for_execute(&params);
    assert_eq!(resolved.agent_id, GENERAL_AGENT_ID);
    assert!(
        resolved.fallback,
        "delegate-without-id should flag fallback=true so execute() logs a warn"
    );
}

#[test]
fn regression_shadow_mode_tolerates_missing_agent_id() {
    // Shadow mode legitimately ignores agent_id (clones the parent
    // setup). The absence of an id is not a miss — fallback must be false.
    let params = serde_json::json!({
        "mode": "shadow",
        "prompt": "parallel subtask",
    });
    let resolved = resolve_agent_id_for_execute(&params);
    assert_eq!(resolved.agent_id, GENERAL_AGENT_ID);
    assert!(
        !resolved.fallback,
        "shadow mode doesn't use agent_id; missing value is not a fallback"
    );
}

#[test]
fn regression_delegate_mode_with_explicit_agent_id_wins() {
    let params = serde_json::json!({
        "agent_id": "builtin:explore",
        "prompt": "find stale sessions",
    });
    let resolved = resolve_agent_id_for_execute(&params);
    assert_eq!(resolved.agent_id, "builtin:explore");
    assert!(!resolved.fallback);
}

#[test]
fn regression_empty_resume_session_id_is_treated_as_absent() {
    for value in ["", "   "] {
        let params = serde_json::json!({
            "prompt": "Explore repo",
            "resume_session_id": value,
        });
        assert_eq!(
            optional_nonempty_string_param(&params, "resume_session_id"),
            None,
            "empty resume_session_id must not enter the resume path"
        );
    }
}

#[test]
fn regression_resume_session_id_hallucinated_shape_rejected() {
    // The error-2 id from the screenshot: first segment is 9 chars
    // (`01dc8f8ae`) instead of the UUID spec's 8 → parses as invalid.
    let hallucinated = "01dc8f8ae-3b3b-7fdc-aa27-50ebe0c15839";
    assert!(
        !looks_like_valid_subagent_session_id(hallucinated),
        "screenshot id should fail shape check — its first segment is 9 chars"
    );

    let real_handle = format!("agent-builtin:general-{}", uuid::Uuid::new_v4());
    assert!(
        looks_like_valid_subagent_session_id(&real_handle),
        "real handle returned from background: true MUST pass shape check"
    );
}

#[test]
fn regression_resume_session_id_canonical_uuid_still_passes_shape_but_is_unknown() {
    // If the LLM produces a syntactically valid UUID, the shape check can't
    // catch it — the runtime still has to hit `load_llm_history` and get
    // an empty Vec, which triggers "No persisted history found". Pins
    // that boundary so a future fix doesn't regress the distinction
    // between "shape-invalid" and "shape-valid-but-unknown".
    let fake_but_valid_uuid = format!("agent-builtin:explore-{}", uuid::Uuid::new_v4());
    assert!(looks_like_valid_subagent_session_id(&fake_but_valid_uuid));
}

// ── Subagent-of-subagent guard ──────────────────────────────────────
//
// Pins the 2026-04-13 audit fix. Builtin explore/general already drop
// the `agent` tool via their `tools` field, but custom `AgentDefinition`s
// with `system_restrict_to_tools = None` and an empty `excluded_tools` would
// otherwise inherit `agent` and recurse. The guard in `AgentTool::execute()`
// is the single chokepoint that enforces the rule regardless of per-agent
// config.

#[test]
fn guard_allows_root_session() {
    // delegation_chain empty ⇒ root session. Legitimate agent tool use
    // (OS / SDE dispatching to explore/general) must still be allowed.
    let chain: Vec<String> = Vec::new();
    assert!(subagent_of_subagent_rejection(&chain).is_none());
}

#[test]
fn guard_rejects_when_already_a_subagent() {
    // A subagent is identified by a non-empty delegation_chain
    // (parent appended its own agent_id before spawning).
    let chain = vec!["builtin:general".to_string()];
    let err =
        subagent_of_subagent_rejection(&chain).expect("subagent MUST NOT spawn another subagent");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("Subagents cannot spawn other subagents"),
                "error message must explain the rule so the LLM can recover, got: {msg}"
            );
            assert!(
                msg.contains("builtin:general"),
                "error message must surface the current chain for debugging, got: {msg}"
            );
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}

// ── Org-member spawn parity gate ────────────────────────────────────
//
// Two structural rules:
//
// * teammate spawning another teammate → reject "Teammates cannot
//   spawn other teammates"
// * in-process teammate spawning a background agent → reject
//   "In-process teammates cannot spawn background agents"
//
// (No definition-level `background` flag exists on orgii's
// `AgentDefinition`; only the caller-supplied `background` param is
// checked.)
//
// We exercise the helper directly (instead of standing up a full
// `AgentTool`) per the file's "narrow regression pins" charter.

fn ctx_with_members(coordinator_id: &str, member_ids: &[&str]) -> AgentOrgRunContext {
    AgentOrgRunContext {
        run_id: "run-test".to_string(),
        org_id: "org-test".to_string(),
        org_name: "Test Org".to_string(),
        org_role: "lead".to_string(),
        coordinator_agent_id: coordinator_id.to_string(),
        coordinator_name: "Lead".to_string(),
        coordinator_role: "lead".to_string(),
        members: member_ids
            .iter()
            .map(|id| AgentOrgContextMember {
                member_id: format!("m-{id}"),
                name: (*id).to_string(),
                role: "worker".to_string(),
                agent_id: (*id).to_string(),
                parent_member_id: None,
            })
            .collect(),
        hierarchy_mode: Default::default(),
        plan_approval_policy: crate::definitions::orgs::PlanApprovalPolicy::Coordinator,
        root_session_id: Some("root-test".to_string()),
    }
}

#[test]
fn org_member_gate_returns_none_for_non_org_session() {
    // No org context at all → never block. This is the plain
    // OS/SDE-without-org parent case.
    assert!(org_roster_spawn_rejection(false, false, None, "builtin:explore", false).is_none());
    assert!(org_roster_spawn_rejection(false, false, None, "builtin:general", true).is_none());
}

#[test]
fn org_roster_gate_rejects_coordinator_spawning_materialized_member() {
    let ctx = ctx_with_members("alice", &["bob", "carol"]);
    let err = org_roster_spawn_rejection(false, false, Some(&ctx), "bob", false)
        .expect("coordinator must not re-spawn an already materialized roster member");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("materialized when the Agent Org launches"),
                "error must explain launch-time materialization, got: {msg}"
            );
            assert!(msg.contains("org_send_message"));
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}

#[test]
fn org_roster_member_target_does_not_bypass_launch_time_materialization() {
    let ctx = ctx_with_members("builtin:os", &["builtin:sde"]);
    let target_is_org_roster_member = ctx
        .members
        .iter()
        .any(|member| member.agent_id == "builtin:sde");
    let ordinary_allowlist_contains_target = ["builtin:explore".to_string()]
        .iter()
        .any(|id| id == "builtin:sde");

    assert!(target_is_org_roster_member);
    assert!(!ordinary_allowlist_contains_target);
    assert!(
        org_roster_spawn_rejection(false, false, Some(&ctx), "builtin:sde", false).is_some(),
        "coordinator must not use the subagent allowlist path to create roster members"
    );
}

#[test]
fn org_member_target_does_not_bypass_allowlist_for_peer_spawn() {
    let ctx = ctx_with_members("builtin:os", &["builtin:sde", "custom:reviewer"]);
    let target_is_org_roster_member = false;
    assert!(ctx
        .members
        .iter()
        .any(|member| member.agent_id == "custom:reviewer"));

    assert!(!target_is_org_roster_member);
    assert!(
        org_roster_spawn_rejection(false, true, Some(&ctx), "custom:reviewer", false).is_some(),
        "member peer-spawn remains blocked; members must message peers instead"
    );
}

#[test]
fn org_roster_gate_rejects_coordinator_spawning_self() {
    let ctx = ctx_with_members("alice", &["bob", "carol"]);
    let err = org_roster_spawn_rejection(false, false, Some(&ctx), "alice", false)
        .expect("coordinator must not spawn itself as a worker");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("cannot spawn roster participant"),
                "error must explain the roster/sub-agent split, got: {msg}"
            );
            assert!(msg.contains("org_send_message"));
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}

#[test]
fn org_member_gate_rejects_member_spawning_another_member() {
    // Member 'bob' tries to dispatch peer 'carol' as a sub-agent.
    // Org members cannot spawn another org participant.
    let ctx = ctx_with_members("alice", &["bob", "carol"]);
    let err = org_roster_spawn_rejection(false, true, Some(&ctx), "carol", false)
        .expect("member must not spawn peer member as sub-agent");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("cannot spawn roster participant"),
                "error must explain the roster/sub-agent split, got: {msg}"
            );
            assert!(
                msg.contains("carol"),
                "error must name the offending target so the LLM can adjust, got: {msg}"
            );
            assert!(
                msg.contains("org_send_message"),
                "error must point at the correct alternative (peer messaging), got: {msg}"
            );
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}

#[test]
fn org_member_gate_rejects_member_spawning_coordinator() {
    // Edge case: a worker tries to spawn the coordinator itself.
    // Same flat-roster invariant — must reject.
    let ctx = ctx_with_members("alice", &["bob"]);
    assert!(
        org_roster_spawn_rejection(false, true, Some(&ctx), "alice", false).is_some(),
        "member must not spawn the coordinator either"
    );
}

#[test]
fn org_member_gate_rejects_member_background_spawn() {
    // Member spawns ordinary `builtin:explore` but with background=true.
    // Lifecycle reason: a backgrounded subagent would outlive the
    // member session, so this combination is rejected.
    let ctx = ctx_with_members("alice", &["bob"]);
    let err = org_roster_spawn_rejection(false, true, Some(&ctx), "builtin:explore", true)
        .expect("member must not spawn background sub-agent");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("background"),
                "error must mention the background-spawn rule, got: {msg}"
            );
            assert!(
                msg.contains("builtin:explore"),
                "error must surface the target id, got: {msg}"
            );
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}

#[test]
fn org_member_gate_allows_member_synchronous_ordinary_subagent() {
    // The whole point: members keep normal delegation rights for
    // non-org sub-agents (explore / general / fork / custom). The
    // gate must not over-block.
    let ctx = ctx_with_members("alice", &["bob"]);
    assert!(
        org_roster_spawn_rejection(false, true, Some(&ctx), "builtin:explore", false).is_none(),
        "member should be allowed to spawn synchronous ordinary sub-agents"
    );
    assert!(
        org_roster_spawn_rejection(false, true, Some(&ctx), "builtin:general", false).is_none(),
        "member should be allowed to spawn builtin:general synchronously"
    );
    assert!(
        org_roster_spawn_rejection(false, true, Some(&ctx), "custom:specialist", false).is_none(),
        "member should be allowed to spawn custom non-org agents synchronously"
    );
}

#[test]
fn org_member_gate_allows_shadow_mode_unconditionally() {
    // Shadow is an internal subagent reuse path that does not create
    // a new persistent participant in the org run. Both the
    // peer-spawn and background-spawn checks must short-circuit on
    // is_shadow=true so this internal mechanism keeps working.
    let ctx = ctx_with_members("alice", &["bob"]);
    assert!(
        org_roster_spawn_rejection(true, true, Some(&ctx), "bob", false).is_none(),
        "shadow mode must bypass the peer-spawn block"
    );
    assert!(
        org_roster_spawn_rejection(true, true, Some(&ctx), "builtin:explore", true).is_none(),
        "shadow mode must bypass the background-spawn block"
    );
}

#[test]
fn guard_rejects_deep_chain_and_reports_full_path() {
    // Custom agents with `system_restrict_to_tools = None` could in theory spawn
    // several layers deep before this guard sees them. The message must
    // print the whole chain so the user can tell which team configured a
    // recursive delegation.
    let chain = vec![
        "custom:manager".to_string(),
        "custom:planner".to_string(),
        "custom:worker".to_string(),
    ];
    let err = subagent_of_subagent_rejection(&chain).expect("deep chain must reject");
    match err {
        ToolError::ExecutionFailed(msg) => {
            assert!(
                msg.contains("custom:manager -> custom:planner -> custom:worker"),
                "must print the full delegation path joined by ' -> ', got: {msg}"
            );
        }
        other => panic!("expected ExecutionFailed, got: {other:?}"),
    }
}
