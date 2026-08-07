use crate::session::AgentExecMode;

// -- parse --
//
// `parse` returns `Option<Self>` so callers must explicitly handle
// unknown variants. The previous catch-all → `Build` fallback was a
// safety reversal: a typo'd wire payload would silently downgrade
// `Plan` / `Ask` / `Review` (read-only) into `Build` (full
// write access). See `state/commands/session/message.rs` for the
// production caller path.

#[test]
fn parse_known_modes() {
    assert_eq!(AgentExecMode::parse("plan"), Some(AgentExecMode::Plan));
    assert_eq!(AgentExecMode::parse("ask"), Some(AgentExecMode::Ask));
    assert_eq!(AgentExecMode::parse("review"), Some(AgentExecMode::Review));
    assert_eq!(AgentExecMode::parse("debug"), Some(AgentExecMode::Debug));
    assert_eq!(
        AgentExecMode::parse("wingman"),
        Some(AgentExecMode::Wingman)
    );
    assert_eq!(AgentExecMode::parse("build"), Some(AgentExecMode::Build));
}

#[test]
fn parse_is_case_insensitive() {
    assert_eq!(AgentExecMode::parse("PLAN"), Some(AgentExecMode::Plan));
    assert_eq!(AgentExecMode::parse("Build"), Some(AgentExecMode::Build));
}

#[test]
fn parse_unknown_returns_none() {
    // Realistic typos that previously slipped through the catch-all and
    // were silently re-routed to `Build`, defeating Plan/Ask
    // read-only safety.
    assert_eq!(AgentExecMode::parse(""), None);
    assert_eq!(AgentExecMode::parse("plann"), None);
    assert_eq!(AgentExecMode::parse("explore"), None); // retired alias
}

// -- as_str --

#[test]
fn as_str_round_trips() {
    for mode in &[
        AgentExecMode::Build,
        AgentExecMode::Ask,
        AgentExecMode::Plan,
        AgentExecMode::Debug,
        AgentExecMode::Review,
        AgentExecMode::Wingman,
    ] {
        assert_eq!(AgentExecMode::parse(mode.as_str()), Some(*mode));
    }
}

// -- policy_layer --

#[test]
fn build_mode_denies_create_plan() {
    let policy = AgentExecMode::Build.policy_layer().unwrap();
    assert!(
        policy.allow.is_none(),
        "Build must use deny-delta (allow=None)"
    );
    assert!(
        policy.deny.contains(&"create_plan".to_string()),
        "Build mode must deny create_plan to force suggest_mode_switch"
    );
}

#[test]
fn plan_mode_uses_deny_delta() {
    let policy = AgentExecMode::Plan.policy_layer().unwrap();
    assert!(
        policy.allow.is_none(),
        "Plan must use deny-delta (allow=None), not an independent allow-list"
    );
    let deny = &policy.deny;
    for blocked in &[
        "edit_file",
        "run_shell",
        "await_output",
        "worktree",
        "manage_lsp",
        "setup_repo",
    ] {
        assert!(
            deny.contains(&blocked.to_string()),
            "Plan deny-list must block {blocked}"
        );
    }
    assert!(
        !deny.contains(&"create_plan".to_string()),
        "Plan mode must NOT deny create_plan"
    );
    assert!(
        !deny.contains(&"read_file".to_string()),
        "Plan mode must not deny read-only tools"
    );
}

#[test]
fn ask_mode_uses_deny_delta() {
    let policy = AgentExecMode::Ask.policy_layer().unwrap();
    assert!(
        policy.allow.is_none(),
        "Ask must use deny-delta (allow=None)"
    );
    let deny = &policy.deny;
    assert!(
        deny.contains(&"edit_file".to_string()),
        "Ask must deny edit_file"
    );
    assert!(
        deny.contains(&"create_plan".to_string()),
        "Ask must deny create_plan (Plan-only)"
    );
    assert!(
        !deny.contains(&"read_file".to_string()),
        "Ask must not deny read-only tools"
    );
    assert!(
        !deny.contains(&"ask_user_questions".to_string()),
        "Ask must allow ask_user_questions"
    );
    assert!(
        !deny.contains(&"task_create".to_string()),
        "Ask must not block Agent Org task dispatch"
    );
    assert!(
        !deny.contains(&"task_update".to_string()),
        "Ask must not block Agent Org task updates"
    );
}

#[test]
fn review_mode_uses_deny_delta() {
    let policy = AgentExecMode::Review.policy_layer().unwrap();
    assert!(
        policy.allow.is_none(),
        "Review must use deny-delta (allow=None)"
    );
    let deny = &policy.deny;
    assert!(
        deny.contains(&"edit_file".to_string()),
        "Review must deny edit_file"
    );
    assert!(
        deny.contains(&"create_plan".to_string()),
        "Review must deny create_plan"
    );
    assert!(
        !deny.contains(&"manage_work_item".to_string()),
        "Review must allow manage_work_item"
    );
    assert!(
        !deny.contains(&"read_file".to_string()),
        "Review must allow read_file"
    );
}

#[test]
fn wingman_mode_has_no_policy_layer() {
    assert!(
        AgentExecMode::Wingman.policy_layer().is_none(),
        "Wingman has no exec-mode policy — the agent definition's systemRestrictToTools is the sole gate"
    );
}

// -- effective_max_iterations (via UnifiedMessageProcessor) --
//
// AgentExecMode no longer owns a max_iterations() method.
// The effective cap is computed in UnifiedMessageProcessor::effective_max_iterations(),
// which takes the lower of (session_model cap, mode cap).
// Tests for the processor helper live in execute.rs.
// Here we only document the expected mode caps for reference.

// -- system_prompt_suffix --

#[test]
fn system_prompt_suffix_nonempty() {
    for mode in &[
        AgentExecMode::Build,
        AgentExecMode::Ask,
        AgentExecMode::Plan,
        AgentExecMode::Debug,
        AgentExecMode::Review,
        AgentExecMode::Wingman,
    ] {
        assert!(!mode.system_prompt_suffix().is_empty());
    }
}

#[test]
fn plan_suffix_instructs_llm_to_call_create_plan_as_submission() {
    let suffix = AgentExecMode::Plan.system_prompt_suffix();
    assert!(
        suffix.contains("create_plan"),
        "Plan prompt must instruct the LLM to use create_plan"
    );
    assert!(
        !suffix.contains("exit_plan_mode"),
        "exit_plan_mode was — prompt must not reference it"
    );
    assert!(
        suffix.contains("IS the submission") || suffix.contains("is the submission"),
        "Plan prompt must make clear that calling create_plan IS the submission step"
    );
    assert!(
        suffix.contains("call `create_plan` immediately"),
        "Plan prompt must prevent post-research drift when approval/buildable plan submission is explicit"
    );
    assert!(
        suffix.contains("treat research as complete after reading that file once and submit the plan now"),
        "Plan prompt must submit directly when the user message already contains enough plan inputs"
    );
}

/// Plan mode is top-level only: subagents cannot author plans, and workers
/// spawned by a Plan-mode parent inherit its read-only policy overlay
/// (`AgentTool::overlay_parent_exec_mode`). The prompt should steer the LLM
/// toward `builtin:explore` for subagent research instead of letting it try
/// to delegate plan authoring.
#[test]
fn plan_suffix_for_pending_feedback_requires_create_plan_before_search() {
    let suffix = AgentExecMode::Plan.system_prompt_suffix();
    assert!(
        suffix.contains("do NOT search first"),
        "Plan prompt must prevent search-first behavior for pending-plan feedback"
    );
    assert!(
        suffix.contains("revision request for the current pending plan"),
        "Plan prompt must classify follow-up feedback as pending-plan revision"
    );
    assert!(
        suffix.contains("call `create_plan` again"),
        "Plan prompt must require a new create_plan revision for pending-plan feedback"
    );
    assert!(
        suffix.contains("new file path") && suffix.contains("fresh evidence"),
        "Plan prompt must narrowly scope when read/search is allowed before create_plan"
    );
}

#[test]
fn plan_suffix_tells_llm_subagents_inherit_read_only_restrictions() {
    let suffix = AgentExecMode::Plan.system_prompt_suffix();
    assert!(
        suffix.contains("subagent") || suffix.contains("subagents"),
        "Plan prompt must mention subagents at least once"
    );
    assert!(
        suffix.contains("inherits your read-only restrictions"),
        "Plan prompt must clarify subagents inherit the Plan-mode read-only overlay"
    );
    assert!(
        !suffix.contains("run in Build mode"),
        "Plan prompt must not claim workers escape into Build mode — the \
         parent's exec-mode overlay now follows into worker policies"
    );
    assert!(
        suffix.contains("builtin:explore"),
        "Plan prompt must recommend builtin:explore for read-only subagent research"
    );
}

// -- read-only modes gate the MCP namespace --
//
// MCP bridge tools (`mcp__{server}__{tool}`) expose no per-tool read-only
// hint, so every read-only mode must deny the whole namespace via the
// `mcp__*` suffix glob — otherwise a side-effecting MCP tool (create
// issue, send message) executes ungated while the mode promises
// "you do NOT implement in this mode".

#[test]
fn read_only_modes_deny_mcp_namespace() {
    use crate::tools::policy::ResolvedToolPolicy;

    for mode in [
        AgentExecMode::Plan,
        AgentExecMode::Ask,
        AgentExecMode::Debug,
        AgentExecMode::Review,
    ] {
        let policy = ResolvedToolPolicy::permissive().with_exec_mode(mode);
        assert!(
            !policy.is_allowed("mcp__linear__create_issue"),
            "{mode:?} must deny MCP tools (no read-only hint => side-effecting)"
        );
        assert!(
            policy.is_allowed("read_file"),
            "{mode:?} must keep builtin read tools"
        );
    }

    let build = ResolvedToolPolicy::permissive().with_exec_mode(AgentExecMode::Build);
    assert!(
        build.is_allowed("mcp__linear__create_issue"),
        "Build must not gate MCP tools"
    );
}

#[test]
fn build_suffix_limits_mode_switch_to_plan() {
    let suffix = AgentExecMode::Build.system_prompt_suffix();
    assert!(suffix.contains("target_mode=\"plan\""));
    assert!(
        !suffix.contains("target_mode=\"explore\""),
        "Explore is gone — Build prompt must not reference it"
    );
}

// After the user approves a plan, the LLM should fall into Build mode
#[test]
fn build_suffix_instructs_direct_file_edits_for_explicit_file_requests() {
    let suffix = AgentExecMode::Build.system_prompt_suffix();
    assert!(
        suffix.contains("exact file path/name and exact content"),
        "Build prompt must make direct file creation/edit requests tool-imperative"
    );
    assert!(
        suffix.contains("use the file editing tool immediately"),
        "Build prompt must prevent post-request thinking drift for explicit file edits"
    );
}

// and execute the approved plan directly. It may use todos for genuinely
// complex work, but the continuation must not force a checklist before
// acting because simple approved plans should go straight to coding tools.
#[test]
fn build_suffix_includes_post_plan_continuation_guidance() {
    let suffix = AgentExecMode::Build.system_prompt_suffix();
    assert!(
        suffix.contains("Post-Plan Continuation"),
        "Build prompt must include the post-plan section header"
    );
    assert!(
        suffix.contains("execute the approved plan directly"),
        "Build prompt must tell the LLM to execute the approved plan"
    );
    assert!(
        suffix.contains("Use `manage_todo` only when"),
        "Build prompt must keep todo usage conditional"
    );
    assert!(
        suffix.contains("create_plan"),
        "Build prompt must name the trigger (last turn ended with create_plan)"
    );
    assert!(
        !suffix.contains("exit_plan_mode"),
        "exit_plan_mode was — Build prompt must not reference it"
    );
}

// Plan mode's submit-step text must reflect the non-blocking flow: no explicit
// reject, user iteration is just a chat reply.
#[test]
fn plan_suffix_describes_nonblocking_submit_flow() {
    let suffix = AgentExecMode::Plan.system_prompt_suffix();
    assert!(
        !suffix.contains("approve, reject, or edit-and-approve"),
        "Plan prompt must drop the old blocking approve/reject/edit wording"
    );
    assert!(
        suffix.contains("Build"),
        "Plan prompt must name the UI action users see (Build button)"
    );
    assert!(
        suffix.contains("no explicit \"reject\"") || suffix.contains("no explicit reject"),
        "Plan prompt must clarify there is no reject action"
    );
}

// -- Display + Default --

#[test]
fn display_matches_as_str() {
    assert_eq!(format!("{}", AgentExecMode::Build), "build");
    assert_eq!(format!("{}", AgentExecMode::Plan), "plan");
    assert_eq!(format!("{}", AgentExecMode::Ask), "ask");
}

#[test]
fn default_is_build() {
    assert_eq!(AgentExecMode::default(), AgentExecMode::Build);
}

// -- Serialize/Deserialize --

#[test]
fn serde_round_trip() {
    let mode = AgentExecMode::Review;
    let json = serde_json::to_string(&mode).unwrap();
    assert_eq!(json, "\"review\"");
    let parsed: AgentExecMode = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, mode);
}

#[test]
fn ask_serde_round_trip() {
    let mode = AgentExecMode::Ask;
    let json = serde_json::to_string(&mode).unwrap();
    assert_eq!(json, "\"ask\"");
    let parsed: AgentExecMode = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed, mode);
}

// -- TurnConfig.max_iterations semantics --
//
// `UnifiedProcessor::effective_max_iterations()` takes the lower of the
// session-model cap and the exec-mode cap. Tests for that helper live in
// execute.rs (processor tests). The constants used there are:
//   Plan / Ask / Review => 30
//   Build / Debug / Wingman     => no mode cap (session model governs alone)

// -- prompt/tool cross-reference lint --
//
// A mode prompt that tells the model to use a tool which that mode's own
// policy layer denies is a ghost reference: the model burns turns calling
// (or tool_search-ing for) something it can never reach. Every backtick-
// quoted token in a mode's prompt suffix that names a *known* tool must be
// allowed by that mode's policy layer.

#[test]
fn mode_prompts_never_reference_tools_their_policy_denies() {
    use crate::tools::policy::ResolvedToolPolicy;

    let known_tools: Vec<&str> = vec![
        crate::tools::names::READ_FILE,
        crate::tools::names::LIST_DIR,
        crate::tools::names::RUN_SHELL,
        crate::tools::names::AWAIT_OUTPUT,
        crate::tools::names::INSPECT_TERMINALS,
        crate::tools::names::CODE_SEARCH,
        crate::tools::names::USE_CODE_MAP,
        crate::tools::names::MANAGE_CODE_MAP,
        crate::tools::names::EDIT_FILE,
        crate::tools::names::DELETE_FILE,
        crate::tools::names::APPLY_PATCH,
        crate::tools::names::MANAGE_WORKSPACE,
        crate::tools::names::QUERY_LSP,
        crate::tools::names::MANAGE_LSP,
        crate::tools::names::MANAGE_TODO,
        crate::tools::names::SETUP_REPO,
        crate::tools::names::ASK_USER_QUESTIONS,
        crate::tools::names::WEB_SEARCH,
        crate::tools::names::WEB_FETCH,
        crate::tools::names::WORKTREE,
        crate::tools::names::AGENT,
        crate::tools::names::TOOL_SEARCH,
        crate::tools::names::CREATE_PLAN,
        crate::tools::names::SUGGEST_MODE_SWITCH,
        crate::tools::names::MANAGE_WORK_ITEM,
        crate::tools::names::MANAGE_PROJECT,
        crate::tools::names::MANAGE_AGENT_DEF,
        crate::tools::names::SEND_TO_INBOX,
        crate::tools::names::CONTROL_DESKTOP_WITH_PEEKABOO,
    ];

    let modes = [
        AgentExecMode::Build,
        AgentExecMode::Ask,
        AgentExecMode::Plan,
        AgentExecMode::Debug,
        AgentExecMode::Review,
        AgentExecMode::Wingman,
    ];

    for mode in modes {
        let suffix = mode.system_prompt_suffix();
        let policy = match mode.policy_layer() {
            Some(layer) => ResolvedToolPolicy::permissive().with_extra_layer(layer),
            None => continue,
        };

        // Extract backtick-quoted tokens and check each one that names a
        // known tool. Negative-context lines ("Do NOT attempt to call",
        // "CANNOT") legitimately mention denied tools; only flag references
        // that instruct usage. We approximate by skipping tokens on lines
        // containing obvious negations.
        for line in suffix.lines() {
            let lower = line.to_lowercase();
            if lower.contains("cannot")
                || lower.contains("do not")
                || lower.contains("don't")
                || lower.contains("never")
                || lower.contains("denied")
                || lower.contains("only if available")
            {
                continue;
            }
            let mut rest = line;
            while let Some(start) = rest.find('`') {
                let after = &rest[start + 1..];
                let Some(end) = after.find('`') else { break };
                let token = &after[..end];
                if known_tools.contains(&token) {
                    assert!(
                        policy.is_allowed(token),
                        "{mode:?} prompt instructs using `{token}` but the mode's policy denies it:\n  line: {line}"
                    );
                }
                rest = &after[end + 1..];
            }
        }
    }
}
