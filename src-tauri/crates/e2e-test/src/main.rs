//! End-to-end integration tests for OS Agent, SDE Agent, and related flows.
//!
//! This binary is a **pure HTTP client** against the running Tauri app's debug-only
//! `/agent/test/*` routes. It does not embed the agent runtime; it drives scenarios
//! through natural-language prompts and validates responses (and optional tool traces).
//!
//! # Prerequisites
//!
//! - Start the app with `npm run tauri:dev` so the local HTTP server and test endpoints
//!   are available (typically `http://127.0.0.1:13847`).
//! - Optional: `scripts/e2e-config.yaml` — loaded by `crate::config::load`.
//!
//! # Usage
//!
//! ```text
//! e2e-test --list
//! e2e-test --scenario <name>
//! e2e-test --group <agent-org|channel|desktop|hooks|housekeeping|learning|lsp|mcp|memory|os|resume|sde|subagent|sync>
//! e2e-test --all
//! e2e-test --config /path/to/e2e-config.yaml
//! ```
//!
//! Build: `cargo build --bin e2e-test` from `src-tauri`.
//!
//! # Scenario groups
//!
//! - **`os`** — Paperclip / OS Agent workflows (tools, projects, work items, routing, etc.).
//! - **`sde`** — Coding agent chat, follow-up, mode switch, SoyD integration.
//! - **`memory`** — Local and cloud memory store/recall (implemented in `sde` module).
//! - **`sync`** — Pluggable sync framework: outbox lifecycle, retry,
//!   exhaustion, discard regression, problem-list wire shape.
//!
//! More detail: `.cursor/skills/e2e-testing/SKILL.md`.

mod agent_org;
mod agent_org_tasks_and_exec_mode;
mod channel;
mod config;
mod desktop;
mod harness;
mod housekeeping;
mod learning;
mod lsp;
mod mcp;
mod os;
mod sde;
mod shell_jobs;
mod subagent;
mod sync;
mod sync_conflict;
mod sync_import;
mod sync_oauth;
mod sync_webhook;

type BoxFuture<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send + 'a>>;

struct ScenarioDef {
    name: &'static str,
    group: &'static str,
    run: for<'a> fn(&'a config::Config) -> BoxFuture<'a>,
}

/// Registers one async scenario: `name` is the CLI `--scenario` key, `group` filters `--group`.
macro_rules! scenario {
    ($group:expr, $name:expr, $func:path) => {
        ScenarioDef {
            name: $name,
            group: $group,
            run: |cfg| Box::pin($func(cfg)),
        }
    };
}

/// Ordered registry of every scenario; keep in sync with documentation when adding entries.
fn all_scenarios() -> Vec<ScenarioDef> {
    vec![
        // OS Agent runtime contracts
        scenario!(
            "os",
            "work-item-launch-invalid-json-rejected",
            os::work_item_launch_invalid_json_rejected
        ),
        // OS Agent Personal Workspace — rules isolation pins
        scenario!(
            "os",
            "os-personal-rules-inject",
            os::os_personal_rules_inject
        ),
        scenario!(
            "sde",
            "sde-personal-rules-isolation",
            os::sde_personal_rules_isolation
        ),
        // SDE Agent scenarios
        scenario!(
            "sde",
            "agent-definition-management-tools-effective-source",
            sde::agent_definition_management_tools_follow_effective_tools_source
        ),
        scenario!(
            "sde",
            "ade-manager-gui-control-tools",
            sde::ade_manager_has_gui_control_tools
        ),
        scenario!(
            "sde",
            "agent-definition-sde-endpoint-rejects-missing-explicit-definition",
            sde::agent_definition_sde_endpoint_rejects_missing_explicit_definition
        ),
        scenario!(
            "sde",
            "cursor-cli-token-only-boundary",
            sde::cursor_cli_token_only_boundary
        ),
        // Per-step narration — agent must emit a status line after each tool
        // call, not batch results into a single end-of-turn dump.
        scenario!("sde", "per-step-narration", sde::per_step_narration),
        scenario!("sde", "mode-switch-skip", sde::mode_switch_skip),
        scenario!("sde", "mode-switch-accept", sde::mode_switch_accept),
        // Agent Core optimization scenarios
        scenario!("sde", "empty-result-guard", sde::empty_result_guard),
        scenario!("sde", "scratchpad-usage", sde::scratchpad_usage),
        scenario!("sde", "scratchpad-edit", sde::scratchpad_edit),
        scenario!("sde", "compaction-resilience", sde::compaction_resilience),
        scenario!("sde", "auto-continue", sde::auto_continue),
        scenario!("sde", "large-file-read", sde::large_file_read),
        scenario!("sde", "concurrent-reads", sde::concurrent_reads),
        scenario!("sde", "away-summary", sde::away_summary),
        scenario!("sde", "dynamic-tool-desc", sde::dynamic_tool_desc),
        scenario!(
            "sde",
            "session-model-max-iterations-turn-cap",
            sde::session_model_max_iterations_turn_cap
        ),
        scenario!("sde", "manage-todo-write", sde::manage_todo_write),
        scenario!(
            "sde",
            "manage-todo-active-form",
            sde::manage_todo_active_form
        ),
        scenario!("sde", "manage-todo-dag", sde::manage_todo_dag),
        scenario!(
            "sde",
            "manage-todo-dag-list-ready",
            sde::manage_todo_dag_list_ready
        ),
        // Nag reminder — after 3 non-todo turns, nag re-triggers manage_todo
        // on the next task-continuation request.
        scenario!(
            "sde",
            "manage-todo-nag-resumes",
            sde::manage_todo_nag_resumes
        ),
        // User-initiated Resume vs crash-recovery injection path
        scenario!(
            "resume",
            "resume-filters-orphan-tool-use",
            sde::resume_filters_orphan_tool_use
        ),
        scenario!(
            "resume",
            "resume-preserves-clean-history",
            sde::resume_preserves_clean_history
        ),
        scenario!(
            "resume",
            "resume-does-not-duplicate-user",
            sde::resume_does_not_duplicate_user
        ),
        scenario!(
            "resume",
            "non-resume-uses-injection-path",
            sde::non_resume_uses_injection_path
        ),
        // last_assistant_text + finalize_agent_result probes.
        // Post-loop finalization + caller-path E2E coverage.
        scenario!(
            "sde",
            "last-assistant-text-recovers-narration",
            sde::last_assistant_text_recovers_narration
        ),
        scenario!(
            "sde",
            "last-assistant-text-returns-none",
            sde::last_assistant_text_returns_none_when_no_narration
        ),
        scenario!(
            "sde",
            "finalize-agent-result-recovers-from-messages",
            sde::finalize_agent_result_recovers_from_messages
        ),
        scenario!(
            "sde",
            "finalize-agent-result-prefers-content",
            sde::finalize_agent_result_prefers_content
        ),
        // Tier-1 silent escalation probes
        scenario!(
            "sde",
            "tier1-escalation-first-truncation",
            sde::tier1_escalation_first_truncation
        ),
        scenario!(
            "sde",
            "tier1-escalation-already-escalated",
            sde::tier1_escalation_already_escalated
        ),
        scenario!(
            "sde",
            "tier1-escalation-already-at-ceiling",
            sde::tier1_escalation_already_at_ceiling
        ),
        // Tool-schema LLM-compatibility pin: tagged-enum params stay flattened
        // (deterministic — no LLM interaction needed)
        scenario!(
            "sde",
            "tool-schema-flat-params",
            sde::tool_schema_flat_params
        ),
        // ask_user_questions schema validation (deterministic — no LLM interaction needed)
        scenario!("sde", "ask-question-schema", sde::ask_question_schema),
        scenario!(
            "sde",
            "ask-question-option-fields",
            sde::ask_question_option_fields
        ),
        // Workspace Memory (L2) runtime scenarios
        scenario!(
            "memory",
            "auto-dream-from-config",
            sde::auto_dream_from_config
        ),
        scenario!(
            "memory",
            "scratchpad-filesystem-check",
            sde::scratchpad_filesystem_check
        ),
        scenario!(
            "memory",
            "session-memory-persisted",
            sde::session_memory_persisted
        ),
        scenario!(
            "memory",
            "extract-memories-tool-heavy",
            sde::extract_memories_tool_heavy
        ),
        scenario!(
            "memory",
            "extract-memories-main-agent-wrote",
            sde::extract_memories_main_agent_wrote
        ),
        scenario!(
            "memory",
            "extract-memories-cursor-advances",
            sde::extract_memories_cursor_advances
        ),
        scenario!(
            "memory",
            "extract-memories-agent-def-opts-in",
            sde::extract_memories_agent_def_opts_in
        ),
        // Learning system scenarios
        scenario!(
            "learning",
            "reflection-pipeline",
            learning::reflection_pipeline
        ),
        scenario!(
            "learning",
            "list-and-deprecate",
            learning::list_and_deprecate
        ),
        scenario!(
            "learning",
            "prompt-injection",
            learning::learning_prompt_injection
        ),
        scenario!("learning", "filtered-list", learning::filtered_list),
        scenario!("learning", "status-lifecycle", learning::status_lifecycle),
        scenario!("learning", "status-report", learning::status_report),
        scenario!("learning", "delete-protection", learning::delete_protection),
        scenario!("learning", "gate-enforced", learning::gate_enforced),
        scenario!(
            "learning",
            "consolidation-pending-excluded",
            learning::consolidation_pending_excluded
        ),
        scenario!(
            "learning",
            "reflection-transcript-excludes-tool-frames",
            learning::reflection_transcript_excludes_tool_frames
        ),
        scenario!(
            "learning",
            "reflection-blacklist-skips-second-call",
            learning::reflection_blacklist_skips_second_call
        ),
        // Unlimited loop + scratchpad globalization
        scenario!("sde", "unlimited-loop", sde::unlimited_loop),
        scenario!("sde", "scratchpad-global", sde::scratchpad_global),
        // Hook system
        scenario!("hooks", "hook-stop-fires", sde::hook_stop_fires),
        scenario!("hooks", "hook-deny-blocks-tool", sde::hook_deny_blocks_tool),
        // Worktree tool (regression baselines)
        scenario!("sde", "worktree-list", sde::worktree_list),
        scenario!("sde", "worktree-enter-exit", sde::worktree_enter_exit),
        // Worktree capability gate
        scenario!(
            "sde",
            "worktree-tool-hidden-from-os-agent",
            sde::worktree_tool_hidden_from_os_agent
        ),
        // Session-workspace mutators + hot-refresh
        scenario!(
            "sde",
            "workspace-add-directory-persists",
            sde::workspace_add_directory_persists
        ),
        scenario!(
            "sde",
            "workspace-remove-directory",
            sde::workspace_remove_directory
        ),
        // `additional_directories` must surface in the next-turn SDE
        // system prompt `## Environment` block.
        scenario!(
            "sde",
            "workspace-prompt-surfaces-additional-dirs",
            sde::prompt_surfaces_additional_dirs
        ),
        // session_launch_impl Step 1b must mirror
        // SessionLaunchParams.additional_directories into the
        // persisted SessionWorkspace before the first LLM turn.
        scenario!(
            "sde",
            "session-launch-seeds-additional-directories",
            sde::launch_seeds_additional_directories
        ),
        // Resume subagent
        scenario!("resume", "resume-subagent", sde::resume_subagent),
        // Streaming concurrent execution
        scenario!("sde", "streaming-concurrent", sde::streaming_concurrent),
        // Skill discovery prefetch
        scenario!(
            "sde",
            "prefetch-zero-wait-collect",
            sde::prefetch_zero_wait_collect
        ),
        scenario!("sde", "skill-prefetch", sde::skill_prefetch),
        // Skill slash command injection
        scenario!("sde", "skill-slash-injection", sde::skill_slash_injection),
        scenario!("sde", "skill-slash-with-args", sde::skill_slash_with_args),
        // message_pipeline.rs path coverage (Positive+negative gap — OS/channel path)
        scenario!(
            "sde",
            "skill-slash-injection-pipeline",
            sde::skill_slash_injection_pipeline_path
        ),
        scenario!(
            "sde",
            "skill-slash-args-pipeline",
            sde::skill_slash_args_pipeline_path
        ),
        // project-level skill/.orgii/skills/ path fix + rules injection verification
        scenario!("sde", "project-skill-slash", sde::project_skill_slash),
        scenario!("sde", "rules-inject", sde::rules_inject),
        // Web tools
        scenario!("sde", "web-fetch-html-quality", sde::web_fetch_html_quality),
        // File history / snapshot
        scenario!("sde", "delete-file-snapshot", sde::delete_file_snapshot),
        scenario!(
            "sde",
            "create-file-rewind-deletes-created-file",
            sde::create_file_rewind_deletes_created_file
        ),
        scenario!(
            "sde",
            "delete-file-tool-snapshot",
            sde::delete_file_tool_snapshot
        ),
        // Permission enforcement
        scenario!("sde", "permission-deny", sde::permission_deny),
        scenario!("sde", "permission-allow", sde::permission_allow),
        scenario!(
            "sde",
            "permission-command-confirmation-allow",
            sde::permission_command_confirmation_allow
        ),
        scenario!(
            "sde",
            "permission-always-allow",
            sde::permission_always_allow
        ),
        scenario!(
            "sde",
            "permission-ask-visibility",
            sde::permission_ask_visibility
        ),
        // AgentExecMode policy enforcement
        scenario!(
            "sde",
            "plan-mode-denies-writes",
            sde::plan_mode_denies_writes
        ),
        scenario!(
            "sde",
            "plan-mode-writes-to-plan-file",
            sde::plan_mode_writes_to_plan_file
        ),
        scenario!(
            "sde",
            "create-plan-marks-ready-for-approval",
            sde::create_plan_marks_ready_for_approval
        ),
        // Background jobs system-reminder injection
        scenario!(
            "sde",
            "bg-reminder-injection",
            sde::background_reminder_injection
        ),
        scenario!(
            "sde",
            "bg-reminder-acknowledge",
            sde::background_reminder_acknowledge
        ),
        // Interactive-tool lifecycle (AwaitingUser status)
        scenario!(
            "sde",
            "plan-approval-lifecycle-timestamp",
            sde::plan_approval_lifecycle_keeps_revision_timestamp
        ),
        scenario!(
            "sde",
            "awaiting-user-survives-complete-last-running",
            sde::awaiting_user_survives_complete_last_running
        ),
        scenario!(
            "sde",
            "running-completes-past-awaiting-user",
            sde::running_event_completes_past_awaiting_user
        ),
        scenario!(
            "sde",
            "awaiting-user-only-completes-nothing",
            sde::awaiting_user_only_completes_nothing
        ),
        // Cancel-interrupt — deterministic flag probes
        scenario!(
            "resume",
            "cancel-interrupt-flag-set",
            sde::cancel_interrupt_flag_set
        ),
        scenario!(
            "resume",
            "cancel-interrupt-no-repair",
            sde::cancel_interrupt_no_repair
        ),
        // Subagent dispatch — deterministic dispatch-check probes
        scenario!(
            "subagent",
            "dispatch-delegate-no-agent-id",
            subagent::dispatch_delegate_no_agent_id
        ),
        scenario!(
            "subagent",
            "dispatch-delegate-with-agent-id",
            subagent::dispatch_delegate_with_agent_id
        ),
        scenario!(
            "subagent",
            "dispatch-shadow-no-agent-id",
            subagent::dispatch_shadow_no_agent_id
        ),
        scenario!(
            "subagent",
            "dispatch-resume-hallucinated",
            subagent::dispatch_resume_hallucinated
        ),
        scenario!(
            "subagent",
            "dispatch-resume-canonical",
            subagent::dispatch_resume_canonical
        ),
        scenario!(
            "subagent",
            "dispatch-subagent-cannot-spawn-subagent",
            subagent::dispatch_subagent_cannot_spawn_subagent
        ),
        scenario!(
            "subagent",
            "background-launch-msg-no-poll",
            subagent::background_launch_msg_no_poll
        ),
        scenario!(
            "subagent",
            "subagent-completion-wakes-parent",
            subagent::subagent_completion_wakes_parent
        ),
        scenario!(
            "subagent",
            "subagent-wake-race-after-poll",
            subagent::subagent_wake_race_after_poll
        ),
        // Background-shell waiting protocol (repeat guard / wake / note / stall)
        scenario!(
            "shell-jobs",
            "shell-chatty-wait-never-breaks",
            shell_jobs::shell_chatty_wait_never_breaks
        ),
        scenario!(
            "shell-jobs",
            "shell-silent-break-then-wake-resumes",
            shell_jobs::shell_silent_break_then_wake_resumes
        ),
        scenario!(
            "shell-jobs",
            "shell-midturn-completion-note",
            shell_jobs::shell_midturn_completion_note
        ),
        scenario!(
            "shell-jobs",
            "shell-stall-advisory-leads-to-kill",
            shell_jobs::shell_stall_advisory_leads_to_kill
        ),
        scenario!(
            "shell-jobs",
            "job-wait-progress-subagent",
            shell_jobs::job_wait_progress_subagent
        ),
        scenario!(
            "shell-jobs",
            "job-midturn-note-subagent",
            shell_jobs::job_midturn_note_subagent
        ),
        // Housekeeping (deferred disk cleanup)
        scenario!(
            "housekeeping",
            "housekeeping-cap-sweep",
            housekeeping::cap_sweep
        ),
        scenario!(
            "housekeeping",
            "housekeeping-ttl-prune",
            housekeeping::ttl_prune
        ),
        scenario!(
            "housekeeping",
            "housekeeping-happy-noop",
            housekeeping::happy_noop
        ),
        scenario!(
            "housekeeping",
            "housekeeping-cursor-config-orphan-evict",
            housekeeping::cursor_config_orphan_evict
        ),
        scenario!(
            "housekeeping",
            "housekeeping-screenshots-ttl",
            housekeeping::screenshots_ttl
        ),
        scenario!(
            "housekeeping",
            "housekeeping-merkle-ttl",
            housekeeping::merkle_ttl
        ),
        scenario!(
            "housekeeping",
            "housekeeping-plans-ttl",
            housekeeping::plans_ttl
        ),
        scenario!(
            "housekeeping",
            "housekeeping-agent-worktrees-orphan-evict",
            housekeeping::agent_worktrees_orphan_evict
        ),
        scenario!(
            "housekeeping",
            "housekeeping-session-images-orphan-evict",
            housekeeping::session_images_orphan_evict
        ),
        scenario!(
            "housekeeping",
            "housekeeping-gateway-bindings-orphan-evict",
            housekeeping::gateway_bindings_orphan_evict
        ),
        scenario!(
            "housekeeping",
            "housekeeping-session-cache-ttl",
            housekeeping::session_cache_ttl
        ),
        // Channel experience defaults
        scenario!(
            "channel",
            "channel-os-memory-defaults",
            channel::os_memory_defaults
        ),
        scenario!(
            "channel",
            "channel-reset-policy-defaults",
            channel::reset_policy_defaults
        ),
        // MCP notification counters + debug inject endpoint
        scenario!(
            "mcp",
            "mcp-counters-snapshot-shape",
            mcp::counters_snapshot_shape
        ),
        scenario!(
            "mcp",
            "mcp-inject-unknown-rejected",
            mcp::inject_unknown_server_rejected
        ),
        scenario!("mcp", "mcp-reset-idempotent", mcp::reset_is_idempotent),
        scenario!(
            "mcp",
            "mcp-invalid-config-preserved",
            mcp::invalid_config_preserved
        ),
        // MCP prompt slash-command debug endpoints
        scenario!(
            "mcp",
            "mcp-list-prompts-unknown-rejected",
            mcp::list_prompts_unknown_server_rejected
        ),
        scenario!(
            "mcp",
            "mcp-list-all-prompts-shape",
            mcp::list_all_prompts_returns_array_shape
        ),
        scenario!(
            "mcp",
            "mcp-get-prompt-unknown-rejected",
            mcp::get_prompt_unknown_server_rejected
        ),
        scenario!(
            "mcp",
            "mcp-prompts-cache-has-false",
            mcp::prompts_cache_has_false_when_empty
        ),
        scenario!(
            "mcp",
            "mcp-tool-progress-counter",
            mcp::tool_progress_counter_increments
        ),
        // agent:mcp_progress broadcast + event-ring caller path
        scenario!(
            "mcp",
            "mcp-progress-event-broadcast",
            mcp::mcp_progress_event_broadcast
        ),
        scenario!(
            "mcp",
            "mcp-progress-event-null-preserved",
            mcp::mcp_progress_event_null_preserved
        ),
        scenario!(
            "mcp",
            "mcp-events-reset-clears-buffer",
            mcp::events_reset_clears_buffer
        ),
        // Live filesystem MCP server end-to-end
        scenario!(
            "mcp",
            "mcp-filesystem-end-to-end",
            mcp::filesystem_end_to_end
        ),
        // 3 real npx MCP servers connected in parallel
        scenario!(
            "mcp",
            "mcp-multi-server-parallel-connect",
            mcp::multi_server_parallel_connect
        ),
        // LLM turn actually invokes an MCP tool
        // (needs a live LLM key — skip-safe via harness, not scheduled
        // into blanket `mcp` group runs unless the user opts in).
        scenario!(
            "mcp",
            "mcp-llm-calls-memory-read-graph",
            mcp::llm_calls_memory_read_graph
        ),
        scenario!(
            "mcp",
            "mcp-llm-multi-step-memory-chain",
            mcp::llm_multi_step_memory_chain
        ),
        // Desktop support probes.
        // Deterministic — no TCC, no live app, no LLM.
        scenario!(
            "desktop",
            "desktop-config-invalid-json-rejected",
            desktop::desktop_config_invalid_json_rejected
        ),
        // Agent Org communication.
        // Drive `OrgSendMessageTool::execute_text` directly via the
        // helper-isolation endpoint and read back via `inbox/list-by-run`.
        // Pure deterministic; no LLM, no full coordinator launch.
        scenario!(
            "agent-org",
            "agent-org-launch-materializes-member-sessions",
            agent_org::launch_materializes_member_sessions_in_run_view
        ),
        scenario!(
            "agent-org",
            "agent-org-production-return-to-work-drains-visible-input",
            agent_org::production_return_to_work_drains_inbox_into_member_transcript
        ),
        scenario!(
            "agent-org",
            "agent-org-run-pause-resume-toggles-status",
            agent_org::run_pause_resume_toggles_status
        ),
        scenario!(
            "agent-org",
            "agent-org-app-restart-transitions-running-runs-to-paused",
            agent_org::app_restart_transitions_running_runs_to_paused
        ),
        scenario!(
            "agent-org",
            "agent-org-run-view-task-counts-split-queued-active",
            agent_org::run_view_distinguishes_pending_and_in_progress_tasks
        ),
        scenario!(
            "agent-org",
            "agent-org-run-view-failed-member-released-task-state",
            agent_org::run_view_shows_failed_member_and_released_task_state
        ),
        scenario!(
            "agent-org",
            "agent-org-control-after-state-run-view-pure-read",
            agent_org::control_after_state_run_view_is_pure_read
        ),
        scenario!(
            "agent-org",
            "agent-org-send-by-name",
            agent_org::send_plain_by_name
        ),
        scenario!(
            "agent-org",
            "agent-org-send-by-agent-id",
            agent_org::send_plain_by_agent_id
        ),
        scenario!(
            "agent-org",
            "agent-org-worker-addresses-coordinator",
            agent_org::worker_addresses_coordinator
        ),
        scenario!(
            "agent-org",
            "agent-org-typed-kinds-round-trip",
            agent_org::typed_kinds_round_trip
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-zero-recipients",
            agent_org::rejects_zero_recipients
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-unknown-recipient-name",
            agent_org::rejects_unknown_recipient_name
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-self-routing-by-id",
            agent_org::rejects_self_routing_by_id
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-unknown-kind",
            agent_org::rejects_unknown_kind
        ),
        scenario!(
            "agent-org",
            "agent-org-plain-requires-summary-and-text",
            agent_org::plain_requires_summary_and_text
        ),
        scenario!(
            "agent-org",
            "agent-org-shutdown-request-requires-request-id",
            agent_org::shutdown_request_requires_request_id
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-retired-kinds",
            agent_org::rejects_retired_kinds
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-plan-approval-request-via-send-message",
            agent_org::rejects_plan_approval_request_via_send_message
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-shutdown-response-to-peer-member",
            agent_org::rejects_shutdown_response_to_peer_member
        ),
        scenario!(
            "agent-org",
            "agent-org-rejects-shutdown-response-rejection-without-note",
            agent_org::rejects_shutdown_response_rejection_without_note
        ),
        // Full coordinator-side shutdown handshake side effect.
        // Asserts that an accepted shutdown_response produces a
        // `MemberTerminated` row authored by the system sender, and
        // that a rejected shutdown_response does NOT.
        scenario!(
            "agent-org",
            "agent-org-accepted-shutdown-yields-member-terminated",
            agent_org::accepted_shutdown_response_yields_member_terminated_row
        ),
        scenario!(
            "agent-org",
            "agent-org-rejected-shutdown-no-member-terminated",
            agent_org::rejected_shutdown_response_does_not_yield_member_terminated
        ),
        // Member-idle notification. When a worker turn ends,
        // `maybe_emit_member_idle` posts a system-authored
        // `MemberIdle` envelope to the coordinator's inbox so the
        // leader's next drain renders `<member_idle .../>` and the
        // LLM is told the worker is now available.
        scenario!(
            "agent-org",
            "agent-org-member-idle-emit-lands-in-coord-inbox",
            agent_org::member_idle_emit_lands_in_coord_inbox
        ),
        scenario!(
            "agent-org",
            "agent-org-member-idle-emit-skips-coordinator",
            agent_org::member_idle_emit_skips_coordinator
        ),
        scenario!(
            "agent-org",
            "agent-org-member-idle-reason-interrupted-roundtrip",
            agent_org::member_idle_emit_propagates_interrupted
        ),
        scenario!(
            "agent-org",
            "agent-org-member-idle-reason-failed-carries-failure-reason",
            agent_org::member_idle_emit_propagates_failed_reason
        ),
        // Org-member spawn gate (`org_member_spawn_rejection`):
        // roster members are materialized at launch, so no org
        // participant may create them through the `agent` tool; members
        // also cannot spawn background sub-agents. Ordinary synchronous
        // non-roster sub-agents stay reachable.
        scenario!(
            "agent-org",
            "agent-org-member-cannot-spawn-peer-member",
            agent_org::member_cannot_spawn_peer_member
        ),
        scenario!(
            "agent-org",
            "agent-org-member-cannot-spawn-background",
            agent_org::member_cannot_spawn_background
        ),
        scenario!(
            "agent-org",
            "agent-org-member-can-spawn-ordinary-subagent",
            agent_org::member_can_spawn_ordinary_subagent
        ),
        scenario!(
            "agent-org",
            "agent-org-coordinator-cannot-spawn-materialized-member",
            agent_org::coordinator_cannot_spawn_materialized_member
        ),
        // Agent-team task system (explicit assignment, unassign-on-
        // shutdown, ExecModeSetRequest). Each scenario is
        // deterministic — seeds task rows / inbox rows via debug
        // endpoints, drives the production drain helper, and asserts
        // the observable post-state.
        scenario!(
            "agent-org",
            "agent-org-tasks-worker-drain-keeps-ownerless",
            agent_org_tasks_and_exec_mode::worker_drain_does_not_assign_ownerless_tasks
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-coordinator-drain-keeps-ownerless",
            agent_org_tasks_and_exec_mode::coordinator_drain_does_not_assign_ownerless_task
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-owned-work-does-not-claim-ownerless",
            agent_org_tasks_and_exec_mode::owned_work_does_not_make_ownerless_task_assignable
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-concurrent-drains-keep-ownerless",
            agent_org_tasks_and_exec_mode::concurrent_worker_drains_leave_ownerless_task_unassigned
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-dependency-readiness-never-auto-assigns",
            agent_org_tasks_and_exec_mode::dependency_state_never_auto_assigns_ownerless_task
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-dependency-cycle-typed-error",
            agent_org_tasks_and_exec_mode::dependency_cycle_rejected_by_task_tool
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-no-pending-no-claim",
            agent_org_tasks_and_exec_mode::no_pending_tasks_means_no_claim
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-shutdown-escalates-without-peer",
            agent_org_tasks_and_exec_mode::accepted_shutdown_releases_owned_open_tasks
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-released-task-needs-explicit-assignment",
            agent_org_tasks_and_exec_mode::released_task_requires_explicit_peer_assignment
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-stale-running-worker-keeps-tasks",
            agent_org_tasks_and_exec_mode::stale_running_worker_keeps_open_tasks_assigned
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-rejected-shutdown-keeps-tasks",
            agent_org_tasks_and_exec_mode::rejected_shutdown_keeps_owned_tasks_assigned
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-legacy-exec-mode-request-rejected",
            agent_org_tasks_and_exec_mode::coordinator_cannot_send_legacy_exec_mode_set_request
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-member-cannot-set-exec-mode",
            agent_org_tasks_and_exec_mode::member_cannot_send_exec_mode_set_request
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-legacy-exec-mode-variants-rejected",
            agent_org_tasks_and_exec_mode::legacy_exec_mode_set_request_variants_are_rejected
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-plan-approval-requires-pending-record",
            agent_org_tasks_and_exec_mode::plan_approval_response_requires_pending_record
        ),
        scenario!(
            "agent-org",
            "agent-org-tasks-task-assigned-drain",
            agent_org_tasks_and_exec_mode::task_assigned_inbox_message_drains_for_recipient
        ),
        // Pluggable sync framework outbox lifecycle.
        // Each scenario uses a freshly-minted throwaway slug + the Echo
        // adapter so they can run alongside other groups without
        // contaminating real project data.
        scenario!("sync", "sync-outbox-roundtrip", sync::outbox_roundtrip),
        scenario!(
            "sync",
            "sync-transient-failure-auto-recovers",
            sync::transient_failure_auto_recovers
        ),
        scenario!(
            "sync",
            "sync-requeue-after-abandon",
            sync::requeue_after_abandon
        ),
        scenario!(
            "sync",
            "sync-abandon-after-max-attempts",
            sync::abandon_after_max_attempts
        ),
        scenario!(
            "sync",
            "sync-discard-blocks-force-push-resurrection",
            sync::discard_blocks_force_push_resurrection
        ),
        scenario!(
            "sync",
            "sync-list-problems-shape",
            sync::list_problems_shape
        ),
        scenario!(
            "sync",
            "linear-oauth-redirect-happy-path",
            sync_oauth::linear_oauth_redirect_happy_path
        ),
        scenario!(
            "sync",
            "linear-oauth-state-mismatch-rejects-token",
            sync_oauth::linear_oauth_state_mismatch_rejects_token
        ),
        scenario!(
            "sync",
            "linear-oauth-refresh-on-expired-token",
            sync_oauth::linear_oauth_refresh_on_expired_token
        ),
        scenario!(
            "sync",
            "linear-oauth-refresh-failure-walks-to-abandoned",
            sync_oauth::linear_oauth_refresh_failure_walks_to_abandoned
        ),
        // Inbound webhook ingestion.
        scenario!(
            "sync",
            "sync-webhook-delivers-inbound-change",
            sync_webhook::webhook_delivers_inbound_change
        ),
        scenario!(
            "sync",
            "sync-webhook-bad-signature-rejected",
            sync_webhook::webhook_bad_signature_rejected
        ),
        scenario!(
            "sync",
            "sync-webhook-fall-back-to-poll-when-stale",
            sync_webhook::webhook_fall_back_to_poll_when_stale
        ),
        // Bulk historical import on first attach.
        scenario!(
            "sync",
            "sync-import-walks-full-history",
            sync_import::import_walks_full_history
        ),
        scenario!(
            "sync",
            "sync-import-retry-resumes-from-cursor",
            sync_import::import_retry_resumes_from_cursor
        ),
        scenario!(
            "sync",
            "sync-import-cancel-is-final",
            sync_import::import_cancel_is_final
        ),
        // Conflict resolution.
        scenario!(
            "sync",
            "sync-conflict-use-local",
            sync_conflict::conflict_use_local_repushes_local
        ),
        scenario!(
            "sync",
            "sync-conflict-use-remote",
            sync_conflict::conflict_use_remote_overwrites_local
        ),
        scenario!(
            "sync",
            "sync-conflict-dismiss",
            sync_conflict::conflict_dismiss_keeps_local
        ),
        // LSP lifecycle scenarios. Require a running
        // `typescript-language-server` on PATH (npm-installed on the
        // dev box; CI must `npm i -g typescript-language-server
        // typescript`). See `crates/e2e-test/src/lsp.rs` for what each
        // scenario asserts and `src-tauri/src/api/agent/test/lsp.rs`
        // for the matching debug endpoints.
        scenario!("lsp", "lsp-start-stop-cycle", lsp::lsp_start_stop_cycle),
        scenario!(
            "lsp",
            "lsp-running-list-empty-when-stopped",
            lsp::lsp_running_list_empty_when_stopped
        ),
        scenario!(
            "lsp",
            "lsp-start-unknown-language-fails",
            lsp::lsp_start_unknown_language_fails
        ),
        scenario!(
            "lsp",
            "lsp-broken-cooldown-blocks-restart",
            lsp::lsp_broken_cooldown_blocks_restart
        ),
        scenario!(
            "lsp",
            "lsp-log-buffer-captures-handshake",
            lsp::lsp_log_buffer_captures_handshake
        ),
    ]
}

fn print_usage() {
    eprintln!("Usage: e2e-test [OPTIONS]");
    eprintln!();
    eprintln!("Options:");
    eprintln!("  --list                  List all available scenarios");
    eprintln!("  --scenario <name>       Run a specific scenario");
    eprintln!(
        "  --group <name>          Run all scenarios in a group (os, sde, memory, learning, housekeeping, channel, mcp, desktop, sync, lsp, agent-org)"
    );
    eprintln!("  --config <path>         Path to e2e-config.yaml");
    eprintln!("  --all                   Run all scenarios");
    eprintln!();
    eprintln!("Requires the Tauri app to be running (npm run tauri:dev).");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  e2e-test --list");
    eprintln!("  e2e-test --scenario sde-followup");
    eprintln!("  e2e-test --group sde");
    eprintln!("  e2e-test --all");
}

#[tokio::main]
async fn main() {
    // `reqwest` is built with `rustls-no-provider`, so the binary must install
    // a process-wide rustls crypto provider before the first TLS-enabled
    // request. The main `app_lib` does this at startup; the standalone
    // `e2e-test` binary has to do it itself. `ring` matches the workspace
    // `tokio-rustls` feature flag.
    let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,e2e_test=info")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();

    let scenarios = all_scenarios();

    if args.len() < 2 {
        print_usage();
        std::process::exit(1);
    }

    if args.contains(&"--list".to_string()) {
        println!("Available E2E scenarios ({} total):", scenarios.len());
        println!();
        let mut current_group = "";
        for sc in &scenarios {
            if sc.group != current_group {
                current_group = sc.group;
                println!("  [{}]", current_group);
            }
            println!("    {}", sc.name);
        }
        return;
    }

    let config_path = args
        .windows(2)
        .find(|w| w[0] == "--config")
        .map(|w| w[1].as_str());

    let cfg = config::load(config_path);
    println!("E2E Test Runner (Rust HTTP Client)");
    println!("  Base URL: {}", cfg.base_url);
    println!("  Model: {}", cfg.model);
    println!("  Account: {}", cfg.account_id);
    println!("  Timeout: {}s", cfg.timeout_secs);
    println!("  Session prefix: {}", cfg.session_prefix);
    println!();

    println!("Checking connectivity...");
    if let Err(err) = harness::check_connectivity(&cfg).await {
        eprintln!("FATAL: {}", err);
        eprintln!("Start the app with `npm run tauri:dev` first.");
        std::process::exit(1);
    }
    println!("  Connected to {}", cfg.base_url);
    println!();

    // A previous interrupted E2E process may have exited before its normal
    // teardown. Remove only reserved Agent Org fixture runs before any real
    // watchdog tick can mistake that residue for product work.
    match agent_org_tasks_and_exec_mode::cleanup_agent_org_fixture_runs(&cfg).await {
        Ok(0) => {}
        Ok(count) => println!("[e2e-cleanup] Scrubbed {count} residual Agent Org run(s)"),
        Err(err) => eprintln!("[e2e-cleanup] Agent Org startup sweep failed: {err}"),
    }

    let selected: Vec<&ScenarioDef> = if let Some(pos) = args.iter().position(|a| a == "--scenario")
    {
        let name = args.get(pos + 1).expect("--scenario requires a name");
        scenarios
            .iter()
            .filter(|sc| sc.name == name.as_str())
            .collect()
    } else if let Some(pos) = args.iter().position(|a| a == "--group") {
        let group = args.get(pos + 1).expect("--group requires a name");
        scenarios
            .iter()
            .filter(|sc| sc.group == group.as_str())
            .collect()
    } else if args.contains(&"--all".to_string()) {
        scenarios.iter().collect()
    } else {
        print_usage();
        std::process::exit(1);
    };

    if selected.is_empty() {
        eprintln!("No matching scenarios found.");
        std::process::exit(1);
    }

    println!("Running {} scenario(s)...", selected.len());
    println!();

    let mut passed = 0;
    let mut failed = 0;
    let total_start = std::time::Instant::now();

    for sc in &selected {
        let start = std::time::Instant::now();
        let ok = (sc.run)(&cfg).await;
        // This is the async equivalent of a `finally`: scenarios return a
        // bool on both success and early-error paths, and cleanup always runs
        // before the harness advances to the next scenario.
        if let Err(err) = agent_org_tasks_and_exec_mode::cleanup_agent_org_fixture_runs(&cfg).await
        {
            eprintln!("[e2e-cleanup] Agent Org scenario sweep failed: {err}");
        }
        let elapsed = start.elapsed();
        println!("  Time: {:.1}s", elapsed.as_secs_f64());

        if ok {
            passed += 1;
        } else {
            failed += 1;
        }
    }

    let total_elapsed = total_start.elapsed();

    // Hard cleanup — scrub project rows that the OS agent may have created
    // during the run. LLM-driven cleanup steps in individual scenarios are
    // best-effort; a stray `e2e-test-*` project left behind gets picked up
    // by project listing and leaks into every channel-session system prompt
    // as "Personal Workspace: e2e-test-automations". This post-run sweep
    // is the last line of defence so a single developer's local E2E run
    // doesn't pollute the gateway Telegram experience.
    scrub_e2e_project_residue();

    println!();
    println!("{}", "=".repeat(70));
    println!("  SUMMARY");
    println!("{}", "=".repeat(70));
    println!(
        "  Total: {}  Passed: {}  Failed: {}",
        selected.len(),
        passed,
        failed
    );
    println!("  Time: {:.1}s", total_elapsed.as_secs_f64());
    println!("{}", "=".repeat(70));

    if failed > 0 {
        std::process::exit(1);
    }
}

/// Delete stray `e2e-test-*` project rows from the project database.
///
/// The cleanup path intentionally bypasses product project IO. Product IO may
/// initialize or migrate an old local schema before it can list rows; E2E
/// cleanup only needs to remove rows minted by the harness and must never turn
/// stale local schema into a suite warning.
fn scrub_e2e_project_residue() {
    let orgii_root = std::env::var("ORGII_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|_| {
            std::env::var("HOME").map(|home| std::path::PathBuf::from(home).join(".orgii"))
        })
        .unwrap_or_else(|_| std::path::PathBuf::from(".orgii"));
    scrub_e2e_projects_db(&orgii_root);
    scrub_e2e_sessions_db(&orgii_root);
}

fn scrub_e2e_projects_db(orgii_root: &std::path::Path) {
    let db_path = orgii_root.join("projects/projects.db");
    if !db_path.exists() {
        println!(
            "[e2e-cleanup] No projects.db at {} — skipping project sweep",
            db_path.display()
        );
        return;
    }

    let mut conn = match rusqlite::Connection::open(&db_path) {
        Ok(conn) => conn,
        Err(err) => {
            eprintln!(
                "[e2e-cleanup] Failed to open projects.db for direct sweep: {}",
                err
            );
            return;
        }
    };
    if let Err(err) = conn.busy_timeout(std::time::Duration::from_secs(5)) {
        eprintln!("[e2e-cleanup] Failed to set projects.db busy timeout: {err}");
    }

    let tx = match conn.transaction() {
        Ok(tx) => tx,
        Err(err) => {
            eprintln!("[e2e-cleanup] Failed to start project sweep transaction: {err}");
            return;
        }
    };

    let removed = match delete_e2e_project_rows(&tx) {
        Ok(removed) => removed,
        Err(err) => {
            eprintln!("[e2e-cleanup] Direct project sweep skipped: {err}");
            return;
        }
    };

    if let Err(err) = tx.commit() {
        eprintln!("[e2e-cleanup] Failed to commit project sweep: {err}");
        return;
    }

    if removed == 0 {
        println!("[e2e-cleanup] No project residue to scrub (clean)");
    } else {
        println!(
            "[e2e-cleanup] Scrubbed {} residual e2e project row(s)",
            removed
        );
    }
}

fn delete_e2e_project_rows(tx: &rusqlite::Transaction<'_>) -> rusqlite::Result<usize> {
    if !sqlite_table_exists(tx, "projects")? {
        return Ok(0);
    }

    tx.execute_batch(
        r#"
        CREATE TEMP TABLE IF NOT EXISTS e2e_project_ids(id TEXT PRIMARY KEY);
        DELETE FROM e2e_project_ids;
        INSERT OR IGNORE INTO e2e_project_ids
            SELECT id FROM projects WHERE slug LIKE 'e2e-test%';
        "#,
    )?;

    if sqlite_table_exists(tx, "workitems")? {
        for table_name in ["workitem_labels", "workitem_extras"] {
            if sqlite_table_exists(tx, table_name)? {
                tx.execute(
                    &format!(
                        "DELETE FROM {table_name} WHERE work_item_id IN \
                         (SELECT id FROM workitems WHERE project_id IN \
                         (SELECT id FROM e2e_project_ids))"
                    ),
                    [],
                )?;
            }
        }

        tx.execute(
            "DELETE FROM workitems WHERE project_id IN (SELECT id FROM e2e_project_ids)",
            [],
        )?;
    }

    for table_name in ["labels", "milestones", "members"] {
        if sqlite_table_exists(tx, table_name)? {
            tx.execute(
                &format!(
                    "DELETE FROM {table_name} WHERE project_id IN (SELECT id FROM e2e_project_ids)"
                ),
                [],
            )?;
        }
    }

    let removed = tx.execute(
        "DELETE FROM projects WHERE id IN (SELECT id FROM e2e_project_ids)",
        [],
    )?;
    tx.execute_batch("DROP TABLE IF EXISTS e2e_project_ids;")?;
    Ok(removed)
}

fn sqlite_table_exists(conn: &rusqlite::Connection, table_name: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        [table_name],
        |row| row.get::<_, bool>(0),
    )
}

/// Delete `osagent-e2e-test-*` / `sdeagent-e2e-test-*` style rows left over in
/// `sessions.db` by previous E2E runs. Without this sweep the agent-sessions
/// list view keeps accumulating "completed" e2e sessions forever (each run
/// adds ~10 rows), which pollutes `list_gateway_agents` output and makes
/// manual Telegram debugging harder. Every `LIKE '%e2e-test%'` clause here
/// targets only rows minted by the E2E harness — the session ids use a
/// hard-coded `e2e-test-` prefix per scenario.
///
/// Best-effort: a missing db or a schema drift prints a warning and returns
/// — never fails the test run. We intentionally use `sqlite3` via a shell
/// call instead of pulling in a runtime dependency on `rusqlite` just for
/// the e2e binary.
fn scrub_e2e_sessions_db(orgii_root: &std::path::Path) {
    let db_path = orgii_root.join("sessions.db");
    if !db_path.exists() {
        println!(
            "[e2e-cleanup] No sessions.db at {} — skipping db sweep",
            db_path.display()
        );
        return;
    }

    let cleanup_targets = [
        ("agent_messages", "session_id"),
        ("session_token_usage", "session_id"),
        ("gateway_bindings", "target_session_id"),
        ("agent_sessions", "session_id"),
    ];

    let mut purged_tables = 0usize;
    for (table_name, session_column) in cleanup_targets {
        if !sqlite_column_exists(&db_path, table_name, session_column) {
            continue;
        }

        let sql = format!(
            "PRAGMA busy_timeout = 5000; DELETE FROM {table_name} WHERE {session_column} LIKE '%e2e-test%';"
        );
        let output = std::process::Command::new("sqlite3")
            .arg(&db_path)
            .arg(sql)
            .output();

        match output {
            Ok(out) if out.status.success() => {
                purged_tables += 1;
            }
            Ok(out) => {
                eprintln!(
                    "[e2e-cleanup] sqlite3 exited with {} for {}.{}: {}",
                    out.status,
                    table_name,
                    session_column,
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
            Err(err) => {
                eprintln!(
                    "[e2e-cleanup] Failed to invoke sqlite3 for db purge: {}",
                    err
                );
                return;
            }
        }
    }

    println!(
        "[e2e-cleanup] Purged e2e-test rows from {} table(s) in {}",
        purged_tables,
        db_path.display()
    );
}

fn sqlite_column_exists(db_path: &std::path::Path, table_name: &str, column_name: &str) -> bool {
    let sql = format!(
        "SELECT 1 FROM pragma_table_info('{table_name}') WHERE name = '{column_name}' LIMIT 1;"
    );
    let output = std::process::Command::new("sqlite3")
        .arg(db_path)
        .arg(sql)
        .output();

    match output {
        Ok(out) if out.status.success() => !String::from_utf8_lossy(&out.stdout).trim().is_empty(),
        Ok(out) => {
            eprintln!(
                "[e2e-cleanup] sqlite3 schema check exited with {}: {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            false
        }
        Err(err) => {
            eprintln!(
                "[e2e-cleanup] Failed to invoke sqlite3 for schema check: {}",
                err
            );
            false
        }
    }
}
