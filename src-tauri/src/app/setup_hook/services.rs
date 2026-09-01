//! Setup stage 2: start the long-lived backend services — transport emitter,
//! CLI session sweep, app menu / dock / tray, repository watcher, session
//! mirroring, the unified IDE server, and the CLI managed proxy.

use crate::runtime_instance;
use crate::{agent_sessions, api, cli_managed_proxy, orgtrack};

pub(crate) fn start_backend_services(
    app: &tauri::App,
    runtime_profile: runtime_instance::RuntimeInstanceProfile,
) {
    // Initialize transport layer (unified event emission)
    {
        use std::sync::Arc;
        use transport::{TauriTransportAdapter, TransportEmitter};

        let adapter = Arc::new(TauriTransportAdapter::new(app.handle().clone()));
        let emitter = Arc::new(TransportEmitter::new(adapter));

        if transport::emitter::set_global_transport_emitter(emitter).is_err() {
            tracing::warn!("[Transport] Failed to set global transport emitter");
        } else {
            tracing::info!("[Transport] Transport layer initialized");
        }
    }
    match agent_sessions::cli::persistence::sweep_stale_sessions() {
        Ok(orphans) if !orphans.is_empty() => {
            tracing::info!(
                count = orphans.len(),
                "[CLI Sessions] swept stale sessions to failed"
            );
            // Kill the orphaned CLI process trees. After a backend
            // restart (crash, quit, or dev-mode Rust recompile) the
            // old CLI agents keep running unsupervised — the new
            // backend has no RUNNING_SESSIONS handle, so the user's
            // cancel button can't reach them. Resume previously did
            // this lazily per-session; do it eagerly for all.
            tauri::async_runtime::spawn(async move {
                for (session_id, pid) in orphans {
                    tracing::info!(
                        "[CLI Sessions] terminating orphaned process tree pid={} (session {})",
                        pid,
                        session_id
                    );
                    agent_sessions::cli::session_runner::terminate_process_tree(
                        pid,
                        &session_id,
                    )
                    .await;
                }
            });
        }
        Ok(_) => {}
        Err(err) => {
            tracing::warn!(error = %err, "[CLI Sessions] Failed to sweep stale sessions");
        }
    }

    system_services::app_menu::setup_menu_events(app.handle());
    tracing::info!("[AppMenu] Menu event handlers registered");

    system_services::app_menu::initialize_recent_paths(app.handle());

    system_services::dock_menu::install_dock_menu();
    system_services::dock_menu::install_dock_menu_action(app.handle());

    match system_services::tray::setup_tray(app.handle()) {
        Ok(()) => tracing::info!("[Tray] System tray initialized"),
        Err(err) => tracing::warn!(error = %err, "[Tray] Failed to setup tray"),
    }

    git::watch::RepoWatchManager::initialize(app.handle().clone());
    tracing::info!("[RepoWatch] Repository watch manager initialized for on-demand active workspaces");

    // Start L3 offline consolidation tick (60s interval, fires on
    // idle/forced triggers). Non-blocking, runs on its own thread +
    // ad-hoc tokio runtime.
    agent_core::specialization::memory::consolidation::spawn_consolidation_tick();

    // Mirror Rust-agent session writes (status, name, model, …) into
    // orgtrack's canonical session store. Registered once here so the
    // agent-core persistence layer stays orgtrack-agnostic; CLI
    // sessions mirror through their own persistence write path.
    agent_core::session::persistence::register_session_mirror_hook(|session_id| {
        if let Err(err) = crate::agent_sessions::session_directory::orgtrack_adapter::upsert_rust_agent_session(session_id) {
            tracing::warn!(session_id, error = %err, "[session-mirror] orgtrack session mirror failed");
        }
    });
    agent_core::session::persistence::register_session_delete_mirror_hook(|session_id| {
        if let Err(err) = crate::agent_sessions::session_directory::orgtrack_adapter::remove_mirrored_session(session_id) {
            tracing::warn!(session_id, error = %err, "[session-mirror] orgtrack delete mirror failed");
        }
    });
    // Repair mirror rows from before the write-path hooks existed
    // (stale/mislabeled rows, cold titles). One bounded pass off the
    // main thread; the hooks keep it fresh from here on.
    tauri::async_runtime::spawn_blocking(|| {
        if let Err(err) = crate::agent_sessions::session_directory::orgtrack_adapter::reconcile_native_session_mirror() {
            tracing::warn!(error = %err, "[session-mirror] startup reconcile failed");
        }
    });


    // Create WebSocket broadcast channel for real-time events
    let (ws_tx, _ws_rx) = tokio::sync::broadcast::channel::<String>(1000);

    // Initialize the global WebSocket broadcaster
    api::init_broadcaster(ws_tx.clone());

    // Dev-only: store AppHandle for test API endpoints
    #[cfg(debug_assertions)]
    api::init_app_handle(app.handle().clone());

    // Start unified IDE server (Git API + Search API + WebSocket) in background
    // thread. Local single-user server: a small worker cap serves it fine and
    // avoids a full core-count worker pool (the app spawns several runtimes).
    let ide_server_port = runtime_profile.ide_server_port;
    std::thread::spawn(move || match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
    {
        Ok(rt) => {
            rt.block_on(async {
                match api::start_server(ws_tx, ide_server_port).await {
                    Ok(_) => tracing::info!("[IDE Server] Server stopped"),
                    Err(err) => {
                        tracing::error!(error = %err, "[IDE Server] Failed to start unified server")
                    }
                }
            });
        }
        Err(err) => tracing::error!(error = %err, "[IDE Server] Failed to create tokio runtime"),
    });

    // Start the local managed-config proxy used by supported CLI agents.
    // It stays idle until a CLI points at 127.0.0.1:17888.
    cli_managed_proxy::start_cli_managed_proxy_thread();

    // First launch defaults session-provenance capture on for supported
    // external agents. Later launches reconcile the platform hook
    // files with the user's per-platform preferences.
    tauri::async_runtime::spawn_blocking(|| {
        if let Err(err) = agent_cli::session_provenance::ensure_hooks_from_preferences() {
            tracing::warn!(error = %err, "[SessionProvenance] Failed to reconcile agent hooks");
        }
    });
    orgtrack::session_provenance::spawn_hook_inbox_drain_loop(app.handle().clone());
    orgtrack::session_provenance::spawn_codex_write_reconciliation_loop(
        app.handle().clone(),
    );

    // Live agent-status registry: frontend fanout handle + restart
    // continuity from the last-status cache (TTL-filtered).
    orgtrack::agent_live_status::init_app_handle(app.handle().clone());
    tauri::async_runtime::spawn_blocking(|| {
        orgtrack::agent_live_status::hydrate_from_disk();
    });
}
