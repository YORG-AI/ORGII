use crate::{agent_sessions, api};

/// Wire the per-domain schema initializers into the `database` crate's
/// dispatcher.
///
/// `database` is a leaf crate (it doesn't depend on `app`), so each domain
/// module's `init_*_tables` is registered here as a function pointer. The
/// dispatcher then runs them in this order on the first call to
/// `database::db::get_connection()` / `get_projects_connection()` — once
/// per physical DB path per process.
///
/// Tests get the same registration via `test_utils::test_env::prime_schema`.
pub(crate) fn register_database_schemas() {
    fn init_sessions(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
        session_persistence::init_session_tables(conn)?;

        agent_core::persistence::session_snapshots::ensure_tables_with(conn)?;
        agent_core::session::persistence::init(conn)?;

        agent_sessions::cli::init_cli_agent_tables(conn)?;
        inbox::init_inbox_tables(conn)?;

        // Drop legacy knowledge graph tables (removed in the L3 memory rebuild).
        // IF EXISTS is safe on fresh installs. Best-effort: any error is non-fatal.
        let _ = conn.execute_batch(
            "DROP TABLE IF EXISTS kg_entities_fts;\n\
             DROP TABLE IF EXISTS kg_relations;\n\
             DROP TABLE IF EXISTS kg_entities;\n\
             DROP TABLE IF EXISTS group_chat_session_links;\n\
             DROP TABLE IF EXISTS group_chat_messages;\n\
             DROP TABLE IF EXISTS group_chat_members;\n\
             DROP TABLE IF EXISTS group_chats;",
        );

        orgtrack_core::store::sqlite::SqliteRecordStore::init_tables(conn)?;
        orgtrack_core::store::sqlite::SqliteRecordStore::init_source_cache_tables(conn)?;

        project_management::lineage::schema::init_lineage_tables(conn)?;

        // Orchestrator runtime state lives in `workitem_extras.extras_json`
        // on `projects.db` — there is no longer a parallel mirror table on
        // `sessions.db`. See `projects::io::orchestrator_view` for the read
        // path used by orchestrator commands and recovery.

        // Unified session persistence returns a non-sqlite error type; we
        // demote it to a warning because failure here is recoverable (the
        // unified layer is optional for most sessions).
        if let Err(err) = agent_core::session::persistence::init(conn) {
            tracing::warn!(
                "[database::db] Unified session persistence init failed: {}",
                err
            );
        }

        agent_core::coordination::agent_org_runs::init_schema(conn)?;
        agent_core::coordination::agent_inbox::init_schema(conn)?;
        agent_core::coordination::agent_org_tasks::init_schema(conn)?;
        agent_core::coordination::agent_member_interventions::init_schema(conn)?;

        // Pending plan-approval snapshots (one row per session with a Build
        // button still awaiting the user). Persists the pending action so the
        // Build button is restored when the session is re-opened after an app
        // restart, instead of being silently lost.
        agent_core::interaction::plan_approval::persistence::init_schema(conn)?;

        // Goal-loop state (standing goal + continuation counter per session)
        // so an Invisible-mode goal survives an app restart.
        agent_core::session::goal_loop::init_schema(conn)?;

        // Opt-in MiniCPM rolling summaries live in an isolated sidecar table.
        // They never replace canonical messages or compact-boundary rows.
        agent_core::session::housekeeper_compaction::init_schema(conn)?;

        Ok(())
    }

    fn init_projects(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
        project_management::projects::schema::init_project_tables(conn)
    }

    database::register_sessions_init(init_sessions);
    database::register_projects_init(init_projects);
}

/// Wire the inversion-of-control hooks the `git` crate uses to call back into
/// the rest of the app (websocket broadcast and automation bridge). Registered
/// once at startup before any git watcher can fire.
pub(crate) fn register_git_hooks() {
    git::hooks::register_websocket_broadcast(Box::new(|msg| {
        api::websocket_handler::broadcast(msg);
    }));
    git::hooks::register_git_event(Box::new(|ev| {
        agent_core::automation::bridge::send_git_event(agent_core::automation::GitBroadcastEvent {
            operation: ev.operation,
            repo_id: ev.repo_id,
            change_type: ev.change_type,
        });
    }));
}

/// Wire the inversion-of-control hook the `settings` crate uses to push
/// settings-file changes back into `agent_core` (HTTP version preference,
/// applied to new provider clients without restart). Registered once at
/// startup before the settings watcher spins up so the very first change
/// event after launch is delivered.
pub(crate) fn register_settings_hooks() {
    settings::hooks::register_on_settings_changed(Box::new(|value| {
        if let Some(http_version) = value.get("network.httpVersion").and_then(|v| v.as_str()) {
            let pref = agent_core::utils::HttpVersionPref::from_setting(http_version);
            agent_core::utils::set_global_http_version_pref(pref);
        }
        agent_core::session::housekeeper_compaction::update_from_settings(value);
    }));
}

/// Wire the inversion-of-control hook `integrations::computer_use_lock` uses
/// to broadcast the user-initiated abort (ESC) to the frontend. Registered
/// once at startup so the `integrations` crate doesn't have to depend on
/// `agent_core::bus`.
pub(crate) fn register_integrations_hooks() {
    integrations::computer_use_lock::register_abort_broadcaster(Box::new(|session_id| {
        agent_core::bus::broadcast_event(
            "agent:computer_use_aborted",
            serde_json::json!({ "sessionId": session_id }),
        );
    }));
}

/// Wire the inversion-of-control hook the `lsp` crate uses to publish
/// language-server diagnostics over the IDE WebSocket. Registered once at
/// startup so the `lsp` crate never has to depend on `api::websocket_handler`.
pub(crate) fn register_lsp_hooks() {
    lsp::register_broadcast(api::websocket_handler::broadcast);
}

/// Wire the IoC hooks the `agent_core::bus` module uses to reach the IDE
/// WebSocket / IPC layer for event broadcast and subscriber counting.
/// Registered once at startup so `agent_core` (and the future extracted
/// `agent-core` crate) never has to depend on `api::websocket_handler`.
pub(crate) fn register_agent_core_bus_hooks() {
    agent_core::bus::register_broadcast(api::websocket_handler::broadcast);
    agent_core::bus::register_subscriber_count(api::websocket_handler::frontend_subscriber_count);
}
