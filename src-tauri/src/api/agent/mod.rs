//! Agent REST API routes.
//!
//! Adds `/agent/*` endpoints to the existing Axum server on port 13847.

pub mod dto;
pub mod public;

#[cfg(debug_assertions)]
pub mod test;

#[cfg(not(debug_assertions))]
pub mod test {
    pub mod core {
        #[tauri::command]
        pub async fn debug_work_item_runtime_launch(
            _request: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            Err("debug_work_item_runtime_launch is only available in debug builds".to_string())
        }

        #[tauri::command]
        pub async fn debug_work_item_scheduler_run_once() -> Result<serde_json::Value, String> {
            Err("debug_work_item_scheduler_run_once is only available in debug builds".to_string())
        }

        #[tauri::command]
        pub async fn debug_routine_scheduler_run_once() -> Result<serde_json::Value, String> {
            Err("debug_routine_scheduler_run_once is only available in debug builds".to_string())
        }
    }
}

pub use public::AgentStatusResponse;

#[cfg(debug_assertions)]
use axum::routing::post;
use axum::{routing::get, Router};

// ============================================
// Router
// ============================================

/// Create the agent API routes.
pub fn create_routes() -> Router {
    let router = Router::new()
        .route("/status", get(public::get_status))
        .route("/config", get(public::get_config))
        .route("/health", get(public::health_check));

    #[cfg(debug_assertions)]
    let router = router
        .route("/test/message", post(test::core::test_send_message))
        .route(
            "/test/cli/cursor-runtime",
            post(test::cli::test_cursor_cli_runtime),
        )
        .route(
            "/test/cli/cursor-account-switch",
            post(test::cli::test_cursor_cli_account_switch),
        )
        .route(
            "/test/cli/claude-code-account-switch",
            post(test::cli::test_claude_code_cli_account_switch),
        )
        .route(
            "/test/cli/codex-account-switch",
            post(test::cli::test_codex_cli_account_switch),
        )
        .route(
            "/test/cli/resume-lock-isolation",
            post(test::cli::test_cli_resume_lock_isolation),
        )
        .route("/test/sde", post(test::sde::test_sde_message))
        .route(
            "/test/file-history/restore",
            post(test::file_history::test_restore_checkpoint),
        )
        .route(
            "/test/tool/code-search",
            post(test::sde::test_code_search_tool),
        )
        .route(
            "/test/tool-schemas/{session_id}",
            get(test::sde::test_tool_schemas),
        )
        .route(
            "/test/effective-tools/{session_id}",
            get(test::sde::test_effective_tools),
        )
        .route(
            "/test/sde/mode-switch/{session_id}",
            get(test::sde::test_sde_mode_switch_pending),
        )
        .route(
            "/test/sde/mode-switch/{session_id}",
            post(test::sde::test_sde_mode_switch_respond),
        )
        .route(
            "/test/sde/mode-switch/{session_id}/seed",
            post(test::sde::test_sde_mode_switch_seed),
        )
        .route(
            "/test/sde/cleanup/{session_id}",
            post(test::sde::test_sde_cleanup),
        )
        .route(
            "/test/sde/todos/{session_id}",
            get(test::sde::test_sde_todos_get),
        )
        .route(
            "/test/sde/todos/{session_id}/ready",
            get(test::sde::test_sde_todos_list_ready),
        )
        .route(
            "/test/sde/seed-orphan",
            post(test::sde::test_sde_seed_orphan),
        )
        .route(
            "/test/sde/transcript/{session_id}",
            get(test::sde::test_sde_transcript_get),
        )
        .route(
            "/test/recovery/counters",
            get(test::core::test_recovery_counters_get),
        )
        .route(
            "/test/recovery/counters-reset",
            post(test::core::test_recovery_counters_reset),
        )
        .route(
            "/test/cancel-flag/{session_id}",
            get(test::core::test_cancel_flag_get),
        )
        .route(
            "/test/cancel-flag/{session_id}",
            post(test::core::test_cancel_flag_take),
        )
        .route(
            "/test/cancel-flag/{session_id}/seed",
            post(test::core::test_cancel_flag_seed),
        )
        .route(
            "/test/em-state/{session_id}",
            get(test::sde::test_em_state_get),
        )
        .route(
            "/test/learning/reflect/{session_id}",
            post(test::learning::test_learning_reflect),
        )
        .route(
            "/test/learning/list",
            get(test::learning::test_learning_list),
        )
        .route(
            "/test/learning/deprecate",
            post(test::learning::test_learning_deprecate),
        )
        .route(
            "/test/learnings/list",
            get(test::learning::test_learnings_list_filtered),
        )
        .route(
            "/test/learnings/set-status",
            post(test::learning::test_learnings_set_status),
        )
        .route(
            "/test/learnings/delete",
            post(test::learning::test_learnings_delete),
        )
        .route(
            "/test/learnings/status",
            get(test::learning::test_learnings_get_status),
        )
        .route(
            "/test/learnings/seed",
            post(test::learning::test_learnings_seed),
        )
        .route(
            "/test/learnings/consolidate",
            post(test::learning::test_learnings_consolidate),
        )
        .route(
            "/test/reflection/seed-messages",
            post(test::learning::test_reflection_seed_messages),
        )
        .route(
            "/test/reflection/transcript",
            post(test::learning::test_reflection_transcript),
        )
        .route(
            "/test/reflection/blacklist",
            post(test::learning::test_reflection_blacklist),
        )
        .route(
            "/test/agent-config/set",
            post(test::learning::test_agent_config_set),
        )
        .route(
            "/test/agent-config/reset",
            post(test::learning::test_agent_config_reset),
        )
        .route(
            "/test/subagent/dispatch-check",
            post(test::core::test_subagent_dispatch_check),
        )
        .route(
            "/test/prefetch/zero-wait",
            post(test::core::test_prefetch_zero_wait),
        )
        .route(
            "/test/prompt-cache/benchmark",
            post(test::core::test_prompt_cache_benchmark),
        )
        .route(
            "/test/sde/permission/{session_id}",
            get(test::sde::test_sde_permission_pending),
        )
        .route(
            "/test/sde/permission/{session_id}",
            post(test::sde::test_sde_permission_respond),
        )
        .route(
            "/test/sde/question/{session_id}",
            get(test::sde::test_sde_question_pending),
        )
        .route(
            "/test/sde/question/{session_id}",
            post(test::sde::test_sde_question_respond),
        )
        .route(
            "/test/sde/plan-approval/{session_id}",
            get(test::sde::test_sde_plan_approval_pending),
        )
        .route(
            "/test/sde/plan-approval/{session_id}",
            post(test::sde::test_sde_plan_approval_respond),
        )
        .route(
            "/test/sde/plan-approval/{session_id}/seed",
            post(test::sde::test_sde_plan_approval_seed),
        )
        .route(
            "/test/sde/plan-approval-lifecycle-order",
            post(test::sde::test_sde_plan_approval_lifecycle_order),
        )
        .route(
            "/test/housekeeping/run",
            post(test::housekeeping::test_housekeeping_run),
        )
        .route(
            "/test/housekeeping/seed-snapshots",
            post(test::housekeeping::test_housekeeping_seed_snapshots),
        )
        .route(
            "/test/housekeeping/seed-aged",
            post(test::housekeeping::test_housekeeping_seed_aged),
        )
        .route(
            "/test/housekeeping/seed-session-dir",
            post(test::housekeeping::test_housekeeping_seed_session_dir),
        )
        .route(
            "/test/housekeeping/snapshot-count",
            get(test::housekeeping::test_housekeeping_snapshot_count),
        )
        .route(
            "/test/housekeeping/seed-aged-file",
            post(test::housekeeping::test_housekeeping_seed_aged_file),
        )
        .route(
            "/test/housekeeping/seed-plan-file",
            post(test::housekeeping::test_housekeeping_seed_plan_file),
        )
        .route(
            "/test/housekeeping/seed-worktree-dir",
            post(test::housekeeping::test_housekeeping_seed_worktree_dir),
        )
        .route(
            "/test/housekeeping/seed-session-image",
            post(test::housekeeping::test_housekeeping_seed_session_image),
        )
        .route(
            "/test/housekeeping/seed-gateway-binding",
            post(test::housekeeping::test_housekeeping_seed_gateway_binding),
        )
        .route(
            "/test/housekeeping/seed-session-cache",
            post(test::housekeeping::test_housekeeping_seed_session_cache),
        )
        .route(
            "/test/housekeeping/session-cache-exists",
            get(test::housekeeping::test_housekeeping_session_cache_exists),
        )
        .route(
            "/test/housekeeping/gateway-binding-exists",
            get(test::housekeeping::test_housekeeping_gateway_binding_exists),
        )
        // Pluggable sync framework E2E surface. Each handler is
        // documented in `api/agent/test/sync.rs`; the matching
        // scenarios live in `crates/e2e-test/src/sync.rs`.
        .route(
            "/test/sync/seed-project",
            post(test::sync::test_sync_seed_project),
        )
        .route("/test/sync/enqueue", post(test::sync::test_sync_enqueue))
        .route("/test/sync/pump", post(test::sync::test_sync_pump))
        .route(
            "/test/sync/echo-flag",
            post(test::sync::test_sync_echo_flag),
        )
        .route("/test/sync/status", get(test::sync::test_sync_status))
        .route("/test/sync/problems", get(test::sync::test_sync_problems))
        .route(
            "/test/sync/inspect-entry",
            get(test::sync::test_sync_inspect_entry),
        )
        .route("/test/sync/requeue", post(test::sync::test_sync_requeue))
        .route("/test/sync/discard", post(test::sync::test_sync_discard))
        .route(
            "/test/sync/force-push",
            post(test::sync::test_sync_force_push),
        )
        .route("/test/sync/cleanup", post(test::sync::test_sync_cleanup))
        // Inbound webhook E2E surface — the matching scenarios live
        // in `crates/e2e-test/src/sync_webhook.rs`. The production listener
        // mounts on `/sync/webhook/:adapter/:slug` (see
        // `webhook_listener::router`); these debug routes only
        // install secrets / inspect + reset state.
        .route(
            "/test/sync/webhook/install",
            post(test::sync::test_sync_webhook_install),
        )
        .route(
            "/test/sync/webhook/status",
            get(test::sync::test_sync_webhook_status),
        )
        .route(
            "/test/sync/webhook/clear-stamp",
            post(test::sync::test_sync_webhook_clear_stamp),
        )
        // Bulk historical import E2E surface. Each handler is
        // documented in `api/agent/test/sync.rs`; matching scenarios
        // live in `crates/e2e-test/src/sync_import.rs`.
        .route(
            "/test/sync/import/ensure-pending",
            post(test::sync::test_sync_import_ensure_pending),
        )
        .route(
            "/test/sync/import/status",
            get(test::sync::test_sync_import_status),
        )
        .route(
            "/test/sync/import/pump",
            post(test::sync::test_sync_import_pump),
        )
        .route(
            "/test/sync/import/cancel",
            post(test::sync::test_sync_import_cancel),
        )
        .route(
            "/test/sync/import/retry",
            post(test::sync::test_sync_import_retry),
        )
        .route(
            "/test/sync/import/force-fail",
            post(test::sync::test_sync_import_force_fail),
        )
        // outbox_conflicts debug surface. Scenarios live in
        // `crates/e2e-test/src/sync_conflict.rs`; handlers in
        // `api/agent/test/sync.rs` under the same name.
        .route(
            "/test/sync/conflict/seed-work-item",
            post(test::sync::test_sync_conflict_seed_work_item),
        )
        .route(
            "/test/sync/conflict/inject-merge-external",
            post(test::sync::test_sync_conflict_inject_merge_external),
        )
        .route(
            "/test/sync/conflict/pump-merge",
            post(test::sync::test_sync_conflict_pump_merge),
        )
        .route(
            "/test/sync/conflict/list",
            get(test::sync::test_sync_conflict_list),
        )
        .route(
            "/test/sync/conflict/use-local",
            post(test::sync::test_sync_conflict_use_local),
        )
        .route(
            "/test/sync/conflict/use-remote",
            post(test::sync::test_sync_conflict_use_remote),
        )
        .route(
            "/test/sync/conflict/dismiss",
            post(test::sync::test_sync_conflict_dismiss),
        )
        .route(
            "/test/sync/conflict/work-item",
            get(test::sync::test_sync_conflict_read_work_item),
        )
        // OAuth + token-refresh E2E surface. Each handler is
        // documented in `api/agent/test/sync_oauth.rs`; the matching
        // scenarios live in `crates/e2e-test/src/sync.rs`.
        .route(
            "/test/sync/oauth/mock-token-server/start",
            post(test::sync_oauth::test_oauth_mock_server_start),
        )
        .route(
            "/test/sync/oauth/mock-token-server/stop",
            post(test::sync_oauth::test_oauth_mock_server_stop),
        )
        .route(
            "/test/sync/oauth/mock-token-server/status",
            get(test::sync_oauth::test_oauth_mock_server_status),
        )
        .route(
            "/test/sync/oauth/set-token-endpoint",
            post(test::sync_oauth::test_oauth_set_token_endpoint),
        )
        .route(
            "/test/sync/oauth/set-client-id",
            post(test::sync_oauth::test_oauth_set_client_id),
        )
        .route(
            "/test/sync/oauth/start",
            post(test::sync_oauth::test_oauth_start),
        )
        .route(
            "/test/sync/oauth/simulate-callback",
            post(test::sync_oauth::test_oauth_simulate_callback),
        )
        .route(
            "/test/sync/oauth/cancel",
            post(test::sync_oauth::test_oauth_cancel),
        )
        .route(
            "/test/sync/oauth/ensure-fresh-token",
            post(test::sync_oauth::test_oauth_ensure_fresh_token),
        )
        .route(
            "/test/sync/oauth/token",
            get(test::sync_oauth::test_oauth_token),
        )
        .route(
            "/test/sync/oauth/seed-token",
            post(test::sync_oauth::test_oauth_seed_token),
        )
        .route(
            "/test/sync/oauth/clear-token",
            post(test::sync_oauth::test_oauth_clear_token),
        )
        .route("/test/resolve-agent", post(test::core::test_resolve_agent))
        .route(
            "/test/work-item-launch/parse",
            post(test::core::test_work_item_launch_parse),
        )
        .route(
            "/test/work-item-runtime/launch",
            post(test::core::test_work_item_runtime_launch),
        )
        .route(
            "/test/work-item/project-seed",
            post(test::core::test_work_item_project_seed),
        )
        .route(
            "/test/work-item/project-delete",
            post(test::core::test_work_item_project_delete),
        )
        .route(
            "/test/work-item/schedule-lookup",
            post(test::core::test_work_item_schedule_lookup),
        )
        .route(
            "/test/work-item/scheduler/run-once",
            post(test::core::test_work_item_scheduler_run_once),
        )
        .route(
            "/test/background-jobs/{session_id}",
            get(test::core::test_background_jobs),
        )
        .route(
            "/test/last-assistant-text",
            post(test::core::test_last_assistant_text),
        )
        .route(
            "/test/finalize-agent-result",
            post(test::core::test_finalize_agent_result),
        )
        .route(
            "/test/tier1-escalation-check",
            post(test::core::test_tier1_escalation_check),
        )
        .route(
            "/test/event-store/complete-last-running",
            post(test::core::test_event_store_complete_last_running),
        )
        // Channel plumbing probes (ex-"gateway" — the LLM router itself
        // is retired; these exercise the surviving inbound/outbound +
        // binding + compact-fork paths used by the OS-per-chat model).
        .route(
            "/test/gateway/binding/set",
            post(test::gateway::test_gateway_binding_set),
        )
        .route(
            "/test/gateway/binding/get",
            post(test::gateway::test_gateway_binding_get),
        )
        .route(
            "/test/gateway/inject-normal",
            post(test::gateway::test_gateway_inject_normal),
        )
        .route(
            "/test/gateway/archive-session",
            post(test::gateway::test_gateway_archive_session),
        )
        .route(
            "/test/gateway/backdate-binding",
            post(test::gateway::test_gateway_backdate_binding),
        )
        .route(
            "/test/gateway/outbound-snapshot",
            post(test::gateway::test_gateway_outbound_snapshot),
        )
        .route(
            "/test/gateway/outbound-tap/arm",
            post(test::gateway::test_gateway_outbound_tap_arm),
        )
        .route(
            "/test/gateway/outbound-tap/disarm",
            post(test::gateway::test_gateway_outbound_tap_disarm),
        )
        .route(
            "/test/gateway/outbound-tap/drain",
            post(test::gateway::test_gateway_outbound_tap_drain),
        )
        .route(
            "/test/gateway/set-reset-policy",
            post(test::gateway::test_gateway_set_reset_policy),
        )
        .route(
            "/test/gateway/force-compact",
            post(test::gateway::test_gateway_force_compact),
        )
        .route(
            "/test/mcp/notification-counters",
            get(test::mcp::test_mcp_notification_counters),
        )
        .route(
            "/test/mcp/notification-counters-reset",
            post(test::mcp::test_mcp_notification_counters_reset),
        )
        .route(
            "/test/mcp/inject-notification",
            post(test::mcp::test_mcp_inject_notification),
        )
        .route(
            "/test/mcp/list-prompts",
            post(test::mcp::test_mcp_list_prompts),
        )
        .route(
            "/test/mcp/list-all-prompts",
            post(test::mcp::test_mcp_list_all_prompts),
        )
        .route("/test/mcp/get-prompt", post(test::mcp::test_mcp_get_prompt))
        .route(
            "/test/mcp/prompts-cache-has",
            post(test::mcp::test_mcp_prompts_cache_has),
        )
        .route(
            "/test/mcp/progress-bump",
            post(test::mcp::test_mcp_progress_bump),
        )
        .route(
            "/test/mcp/emit-progress-event",
            post(test::mcp::test_mcp_emit_progress_event),
        )
        .route(
            "/test/mcp/inject-server",
            post(test::mcp::test_mcp_inject_server),
        )
        .route(
            "/test/mcp/disconnect-server",
            post(test::mcp::test_mcp_disconnect_server),
        )
        .route(
            "/test/mcp/reconnect-server",
            post(test::mcp::test_mcp_reconnect_server),
        )
        .route("/test/mcp/list-tools", post(test::mcp::test_mcp_list_tools))
        .route("/test/mcp/call-tool", post(test::mcp::test_mcp_call_tool))
        .route(
            "/test/mcp/invalid-config-preserved",
            post(test::mcp::test_mcp_invalid_config_preserved),
        )
        .route("/test/events/recent", get(test::core::test_events_recent))
        .route("/test/events/reset", post(test::core::test_events_reset))
        .route(
            "/test/session/workspace/add-directory",
            post(test::workspace::test_session_workspace_add_directory),
        )
        .route(
            "/test/session/workspace/remove-directory",
            post(test::workspace::test_session_workspace_remove_directory),
        )
        .route(
            "/test/session/workspace/list",
            post(test::workspace::test_session_workspace_list),
        )
        .route(
            "/test/session/prompt/environment-block",
            post(test::workspace::test_session_prompt_environment_block),
        )
        .route(
            "/test/session/launch-seed-only",
            post(test::workspace::test_session_launch_seed_only),
        )
        .route(
            "/test/session/workspace/list-from-db",
            post(test::workspace::test_session_workspace_list_from_db),
        )
        .route(
            "/test/session/aggregate-list-filter",
            post(test::workspace::test_session_aggregate_list_filter),
        )
        .route(
            "/test/session/llm-history",
            post(test::workspace::test_session_llm_history),
        )
        .route(
            "/test/session/seed-compacted-history",
            post(test::workspace::test_session_seed_compacted_history),
        )
        .route(
            "/test/session/provider-request-capture",
            post(test::workspace::test_session_provider_request_capture),
        )
        .route(
            "/test/session/seed-raw-history",
            post(test::workspace::test_session_seed_raw_history),
        )
        .route(
            "/test/session/parse-exec-mode",
            post(test::workspace::test_parse_exec_mode),
        )
        .route(
            "/test/session/parse-status",
            post(test::workspace::test_parse_session_status),
        )
        .route(
            "/test/session/resolve-exec-mode-from-wire",
            post(test::workspace::test_resolve_exec_mode_from_wire),
        )
        .route(
            "/test/session/update-status-via-cmd",
            post(test::workspace::test_session_update_status_via_cmd),
        )
        .route(
            "/test/session/aggregate-list-via-cmd",
            post(test::workspace::test_session_aggregate_list_via_cmd),
        )
        // Agent Org runtime probes — inter-agent E2E observability.
        // See `api::agent::test::agent_org` for the contract.
        .route(
            "/test/agent-org/seed",
            post(test::agent_org::test_agent_org_seed),
        )
        .route(
            "/test/agent-org/launch-coordinator",
            post(test::agent_org::test_agent_org_launch_coordinator),
        )
        .route(
            "/test/agent-org/inbox/list-by-run",
            post(test::agent_org::test_agent_org_inbox_list_by_run),
        )
        .route(
            "/test/agent-org/inbox/seed",
            post(test::agent_org::test_agent_org_inbox_seed),
        )
        .route(
            "/test/agent-org/follow-up-message",
            post(test::agent_org::test_agent_org_follow_up_message),
        )
        .route(
            "/test/agent-org/send-message-direct",
            post(test::agent_org::test_agent_org_send_message_direct),
        )
        .route(
            "/test/agent-org/task-tool-direct",
            post(test::agent_org::test_agent_org_task_tool_direct),
        )
        .route(
            "/test/agent-org/drain-inbox",
            post(test::agent_org::test_agent_org_drain_inbox),
        )
        .route(
            "/test/agent-org/post-member-idle",
            post(test::agent_org::test_agent_org_post_member_idle),
        )
        .route(
            "/test/agent-org/tasks/seed",
            post(test::agent_org::test_agent_org_tasks_seed),
        )
        .route(
            "/test/agent-org/tasks/list",
            post(test::agent_org::test_agent_org_tasks_list),
        )
        .route(
            "/test/agent-org/stale-workers/seed-run",
            post(test::agent_org::test_agent_org_seed_stale_worker_run),
        )
        .route(
            "/test/agent-org/stale-workers/seed-cli-member",
            post(test::agent_org::test_agent_org_seed_cli_member_run),
        )
        .route(
            "/test/agent-org/stale-workers/release-tasks",
            post(test::agent_org::test_agent_org_release_stale_worker_tasks),
        )
        .route(
            "/test/agent-org/find-worker-session",
            post(test::agent_org::test_agent_org_find_worker_session),
        )
        .route(
            "/test/agent-org/run-view",
            post(test::agent_org::test_agent_org_run_view),
        )
        .route(
            "/test/agent-org/durable-invariants",
            post(test::agent_org::test_agent_org_durable_invariants),
        )
        .route(
            "/test/agent-org/run/pause",
            post(test::agent_org::test_agent_org_pause_run),
        )
        .route(
            "/test/agent-org/run/resume",
            post(test::agent_org::test_agent_org_resume_run),
        )
        .route(
            "/test/agent-org/simulate-app-restart",
            post(test::agent_org::test_agent_org_simulate_app_restart),
        )
        .route(
            "/test/agent-org/check-member-spawn-gate",
            post(test::agent_org::test_agent_org_check_member_spawn_gate),
        )
        // Desktop support probes. Deterministic — no TCC, no live app, no LLM.
        // See `api/agent/test/desktop.rs` for the rationale.
        .route(
            "/test/desktop/config/parse",
            post(test::desktop::test_desktop_config_parse),
        )
        // LSP lifecycle E2E surface — matching scenarios live in
        // `crates/e2e-test/src/lsp.rs`. These reach the live
        // `LspManager` registered as Tauri-managed state; there is no
        // parallel test instance.
        .route("/test/lsp/start", post(test::lsp::test_lsp_start))
        .route("/test/lsp/stop", post(test::lsp::test_lsp_stop))
        .route("/test/lsp/running", get(test::lsp::test_lsp_running))
        .route("/test/lsp/did-open", post(test::lsp::test_lsp_did_open))
        .route("/test/lsp/log/{language}", get(test::lsp::test_lsp_log))
        .route(
            "/test/lsp/seed-broken",
            post(test::lsp::test_lsp_seed_broken),
        );

    router
}
