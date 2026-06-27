//! ORGII Tauri Application Library
//!
//! This is the main library crate for the ORGII desktop application built with Tauri.
//! It provides the Rust backend for the frontend React application.
//!
//! # Architecture Overview
//!
//! The application is structured into several modules:
//!
//! - **[`api`]**: HTTP/WebSocket server for Git operations, search, and real-time events
//! - **[`git`]**: Git utilities, bundle creation, and file system watching
//! - **[`search`]**: File search (fuzzy) and code search (regex, symbols)
//! - **[`session`]**: Session management, indexing, and folder archiving
//! - **[`processes`]**: External process management (sidecars)
//! - **[`platform`]**: Platform-specific features (notifications, system tray)
//! - **[`terminal`]**: PTY (pseudo-terminal) management for integrated terminal
//! - **[`browser`]**: Browser windows and inline webviews
//! - **[`integrations`]**: External integrations (external IDEs, Cursor credentials)
//! - **[`lsp`]**: Language Server Protocol client for code intelligence
//! - **[`test_runner`]**: Test discovery and execution for various frameworks
//!
//! # Initialization Sequence
//!
//! The [`run()`] function initializes the application in the following order:
//!
//! 1. Tauri plugins (single-instance, deep-link, OAuth, filesystem, shell, notifications)
//! 2. Repository watch manager for real-time git status
//! 3. WebSocket broadcast channel for frontend events
//! 4. CLI sessions (CLI agent spawning, parsing, persistence)
//! 5. Proxy integration (ORGII billing, MITM for Cursor/Kiro/Copilot)
//! 5. Unified IDE server (Git API + Search API + WebSocket on port 13847)
//! 6. Centralized index manager for lightweight workspace indexing
//! 7. Test runner, PTY, and LSP state managers
//!
//! # Tauri Commands
//!
//! Commands are exposed to the frontend via `tauri::command` and registered in
//! the `invoke_handler` (see `commands/handler_list.inc`, referenced from the generated
//! include in [`run`]).
//! They are grouped by area in that file (e.g. browser, search, agents).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
use tauri::{Listener, Manager};

#[cfg(unix)]
fn write_panic_report_to_stderr(report: &str) {
    unsafe {
        libc::write(libc::STDERR_FILENO, report.as_ptr().cast(), report.len());
    }
}

#[cfg(not(unix))]
fn write_panic_report_to_stderr(report: &str) {
    let _ = std::io::Write::write_all(&mut std::io::stderr().lock(), report.as_bytes());
}

fn dev_startup_debug_enabled() -> bool {
    std::env::var("ORGII_DEV_STARTUP_DEBUG").as_deref() == Ok("true")
}

// ============================================
// Module Declarations
// ============================================

// `agent_core` is now a workspace crate at `crates/agent-core/`. The
// `commands/handler_list.inc` and call sites inside `app/src/` reach it
// directly as `agent_core::…`.

// Workstation (IDE functionality and development tools)
pub mod agent_sessions; // Agent session management (CLI, event pipeline, persistence, aggregation)
pub mod api;
pub mod benchmark;
pub mod cursor_ide_watch; // cursor_ide streaming delta watch commands
pub mod infrastructure; // In-tree-only cross-cutting infrastructure (paths, platform, archive, index_manager, jsonrpc, housekeeping). Leaf pieces live in their own workspace crates.
pub mod orgtrack;
pub(crate) mod setup;
pub mod usage_diagnostics;

#[cfg(test)]
pub mod test_utils;

use crate::setup::*;

use infrastructure::index_manager::IndexManager;

// ============================================
// Global State
// ============================================

// Python sidecar (`newmain`) has been removed.
// All backend functionality is now handled natively in Rust:
// - Session execution: cli_session module (CLI agent spawning + parsing)
// - Proxy billing: proxy module (token allocation + MITM proxy)
// - Config/Providers: key_vault module (reads credentials.json)
// - Git operations: api/git module (git2 crate)
// - Repo management: git/repos module (SQLite + git watcher)
// See docs/architecture-guide/unified-proxy-architecture-0210.md

/// Main entry point for the Tauri application.
///
/// This function:
/// 1. Configures Tauri plugins (deep-link, OAuth, FS, shell, notifications, store, process, updater)
/// 2. Registers all Tauri command handlers organized by module
/// 3. Runs the setup hook which initializes all backend services
///
/// # Panics
///
/// Panics if the Tauri application fails to build or run. Individual subsystems
/// (sidecar, etc.) fail gracefully without crashing the app.
///
/// # Example
///
/// ```ignore
/// // Called from main.rs
/// app_lib::run();
/// ```
pub fn run() {
    // Augment $PATH from the user's login shell so binary probes (`which npm`,
    // `which claude`, etc.) work correctly when the app is launched from the
    // Dock/Finder, where macOS only provides the minimal system PATH.
    // Clear the stale cache so it is rebuilt with the correct PATH on first use.
    app_paths::augment_path_from_shell();
    app_paths::clear_dependencies_cache();

    // Wire schema initializers into the `database` crate before any other
    // setup runs — anything that opens a connection (logging dir creation,
    // background tasks, the Tauri setup hook) relies on the dispatcher
    // already being populated.
    register_database_schemas();

    // Wire the git core's IoC hooks before any watcher can spin up.
    register_git_hooks();

    // Wire the settings IoC hook so external `settings.jsonc` edits push
    // back into `agent_core` (HTTP version preference). Must run before
    // the watcher in `setup` starts, otherwise the first change event
    // after launch silently drops the HTTP-version update.
    register_settings_hooks();

    // Wire `integrations::computer_use_lock`'s abort broadcaster so the ESC
    // hotkey can fan an event out to the frontend without the `integrations`
    // crate depending on `agent_core::bus`.
    register_integrations_hooks();

    // Wire the LSP diagnostics broadcast pointer so the `lsp` crate can
    // publish `textDocument/publishDiagnostics` notifications to the IDE
    // WebSocket without depending back into `api::websocket_handler`.
    register_lsp_hooks();

    // Wire the agent_core bus IoC pointers (frontend broadcast +
    // subscriber-count) so `agent_core::bus::broadcast_event` and
    // `ActionBridge::has_frontend` can reach the IDE WebSocket / IPC layer
    // without depending back into `api::websocket_handler`. This is the
    // counterpart to the LSP hook above.
    register_agent_core_bus_hooks();

    // Wire the event-pipeline bridge so `agent_core` can drive the live
    // `EventStore` (push events, notify, stamp tool_call args, pin/unpin
    // child sessions, flush streaming) without depending on
    // `agent_sessions::event_pipeline::commands`.
    register_event_pipeline_bridge();

    // Wire the persistence bridge so `agent_core` (memory, consolidation,
    // reflection, learnings) can open SQLite connections without
    // depending on `session_persistence::get_connection`.
    register_persistence_bridge();

    // Wire `SessionEvent::recompute_extracted` to the real extractor in
    // `event_pipeline::extractors`. Must run before any session ingests
    // events, otherwise the first batch's `extracted` envelopes are
    // silently `None` and the rendering layer falls back to raw JSON.
    register_session_event_extractor();

    // Wire `project_management::lineage::git_bridge::get_commit_diff` to
    // the `git2`-backed implementation in `git_api::commands::diff`.
    // Must run before the first git commit fires its post-commit hook,
    // otherwise the slot panics.
    register_lineage_git_bridge();

    // Wire `agent_core::foundation::session_bridge::launch_cli_agent` to
    // the `cli_agent_create` + `cli_agent_run` adapter. Required for any
    // CLI launch path (`launch_session` -> `launch_cli_agent`).
    register_cli_launch_bridge();

    // Install the process-wide rustls crypto provider before any TLS code
    // runs. We use the `rustls-no-provider` feature on reqwest (and on
    // tokio-rustls / rmcp) to avoid pulling aws-lc-rs into the build, so
    // we must explicitly tell rustls to use `ring`. Without this, the
    // first reqwest::Client::new() panics with `No provider set` from
    // inside an FFI callback (Cocoa NSApplicationDelegate), aborting the
    // process before any window appears.
    if let Err(err) = tokio_rustls::rustls::crypto::ring::default_provider().install_default() {
        tracing::warn!(
            error = ?err,
            "failed to install rustls ring crypto provider; it may already be installed"
        );
    }

    // ============================================
    // Initialize Tracing (file logging)
    // ============================================
    // Logs to ~/.orgii/logs/orgii.log (daily rotation)
    {
        use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

        let log_dir = app_paths::logs_dir();
        std::fs::create_dir_all(&log_dir).ok();

        let file_appender = tracing_appender::rolling::daily(&log_dir, "orgii.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);
        // Leak the guard so it lives for the entire process lifetime
        std::mem::forget(_guard);

        let env_filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new(
                "info,\
                 key_vault=debug,\
                 app_lib::agent_core=debug,\
                 app_lib::agent_core::tool_infra=debug,\
                 hyper=warn,\
                 tungstenite=warn,\
                 tokio_tungstenite=warn",
            )
        });

        tracing_subscriber::registry()
            .with(env_filter)
            .with(
                fmt::layer()
                    .with_target(true)
                    .with_thread_ids(true)
                    .with_ansi(false)
                    .with_writer(non_blocking),
            )
            .init();

        tracing::info!(
            "Tracing initialized — log file: {}/orgii.log",
            log_dir.display()
        );
    }

    // Panic hook: ensure any panic — even one inside an FFI callback like
    // tao's NSApplicationDelegate — gets its message captured to the log
    // file and stderr before the process aborts. Without this, a panic in
    // setup() shows only an opaque `panic_cannot_unwind` backtrace with no
    // location or message.
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<no message>".to_string());
        let backtrace = std::backtrace::Backtrace::force_capture();
        let report = format!(
            "\n=== PANIC ===\nat {location}\nmessage: {message}\n\n{backtrace}\n=============\n"
        );
        write_panic_report_to_stderr(&report);
        tracing::error!(location = %location, message = %message, "panic caught by hook");
    }));

    let builder = tauri::Builder::default();

    // E2E WebDriver automation — only when built with `--features webdriver` (debug/test only).
    #[cfg(all(debug_assertions, feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    builder
        // NOTE: Single-instance disabled for development - uncomment for production
        // .plugin(tauri_plugin_single_instance::init(|_app, argv, _cwd| {
        //   tracing::info!(?argv, "a new app instance was opened and the deep link event was already triggered");
        //   // when defining deep link schemes at runtime, you must also check `argv` here
        // }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_oauth::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_auth_session::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_drag::init())
        .on_window_event(|_window, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::WindowEvent::ScaleFactorChanged { .. }
                | tauri::WindowEvent::ThemeChanged(_)
                | tauri::WindowEvent::Focused(true) => {
                    if let Some(webview_window) = _window.app_handle().get_webview_window(_window.label()) {
                        app_window::set_traffic_light_position(
                            &webview_window,
                            app_window::TRAFFIC_LIGHT_X,
                            app_window::TRAFFIC_LIGHT_Y,
                        );
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(include!(concat!(
            env!("OUT_DIR"),
            "/tauri_invoke_handler_expr.rs"
        )))
        .setup(|app| {
            // Python sidecar removed — all backend logic now in Rust.

            #[cfg(all(debug_assertions, feature = "webdriver"))]
            {
                use tauri::Manager;
                if let Some(main_window) = app.handle().get_webview_window("main") {
                    let _ = main_window.show();
                    let _ = main_window.set_focus();
                    tracing::info!("[WebDriver] Ensured main window is visible for E2E automation");
                } else {
                    app_window::recreate_main_window(app.handle())?;
                    tracing::info!("[WebDriver] Recreated main window for E2E automation");
                }
            }

            {
                use tauri::Manager;
                if let Some(main_window) = app.handle().get_webview_window("main") {
                    #[cfg(not(target_os = "macos"))]
                    {
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                    }

                    #[cfg(target_os = "macos")]
                    {
                        app_window::apply_window_background_color(&main_window);
                        app_window::set_traffic_light_position(
                            &main_window,
                            app_window::TRAFFIC_LIGHT_X,
                            app_window::TRAFFIC_LIGHT_Y,
                        );
                    }

                    app_window::apply_host_desktop_window_chrome(&main_window);
                }
            }

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

            perf_utils::ram_history::start_sampler();
            tracing::info!("[RamHistory] Background RAM sampler started");

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
            tracing::info!("[RepoWatch] Event-driven repository watch manager initialized");

            git::repos::hydrate_repos_into_watcher();
            tracing::info!("[RepoWatch] Persisted repos loaded from DB");

            // Start L3 offline consolidation tick (60s interval, fires on
            // idle/forced triggers). Non-blocking, runs on its own thread +
            // ad-hoc tokio runtime.
            agent_core::specialization::memory::consolidation::spawn_consolidation_tick();


            // Create WebSocket broadcast channel for real-time events
            let (ws_tx, _ws_rx) = tokio::sync::broadcast::channel::<String>(1000);

            // Initialize the global WebSocket broadcaster
            api::init_broadcaster(ws_tx.clone());

            // Dev-only: store AppHandle for test API endpoints
            #[cfg(debug_assertions)]
            api::init_app_handle(app.handle().clone());

            // Start unified IDE server (Git API + Search API + WebSocket) in background thread
            std::thread::spawn(move || match tokio::runtime::Runtime::new() {
                Ok(rt) => {
                    rt.block_on(async {
                        match api::start_server(ws_tx).await {
                            Ok(_) => tracing::info!("[IDE Server] Server stopped"),
                            Err(err) => {
                                tracing::error!(error = %err, "[IDE Server] Failed to start unified server")
                            }
                        }
                    });
                }
                Err(err) => tracing::error!(error = %err, "[IDE Server] Failed to create tokio runtime"),
            });

            // Initialize Rust EventStore state
            app.manage(agent_sessions::event_pipeline::commands::EventStoreState::new());
            tracing::info!("[EventStore] Rust event store initialized");

            // Initialize centralized Index Manager
            let index_manager = std::sync::Arc::new(std::sync::Mutex::new(IndexManager::new()));
            app.manage(index_manager);
            tracing::info!("[IndexManager] Centralized index manager initialized");

            // Initialize Test Runner state
            app.manage(test_runner::TestRunnerState::new());
            tracing::info!("[TestRunner] Test runner state initialized");

            // Initialize PTY state for terminal sessions
            let pty_state = ::terminal::pty_commands::pty::PtyState::new();
            let pty_sessions_arc = pty_state.sessions_arc();
            app.manage(pty_state);
            tracing::info!("[PTY] Terminal PTY state initialized");

            // Initialize LSP Manager
            let lsp_manager =
                std::sync::Arc::new(tokio::sync::Mutex::new(lsp::LspManager::new()));
            app.manage(lsp_manager);
            tracing::info!("[LSP] LSP manager initialized");

            // Initialize Component Index state (for DOM-to-source mapping)
            app.manage(ui_indexer::UiIndexState::new());
            tracing::info!("[UiIndexer] Component index state initialized");


            let agent_browser_config = match settings::file_io::read_settings() {
                Ok(settings_value) => shared_state::AgentBrowserConfig::from_settings(&settings_value),
                Err(err) => {
                    tracing::warn!(
                        "[Browser] Failed to read Agent Browser settings; using defaults: {}",
                        err
                    );
                    shared_state::AgentBrowserConfig::default()
                }
            };

            // Initialize independent browser and screenshot state (to avoid circular dependencies)
            let agent_browser = std::sync::Arc::new(tokio::sync::Mutex::new(
                shared_state::AgentBrowserController::with_config(agent_browser_config),
            ));
            let screenshot_store = std::sync::Arc::new(shared_state::ScreenshotStore::new());

            // Manage browser and screenshot state independently for dependency injection
            app.manage(agent_browser.clone());
            app.manage(screenshot_store.clone());
            tracing::info!("[Browser] Agent browser controller and screenshot store initialized");

            // Initialize Unified Agent State (replaces separate OS/SDE states)
            let mut unified_state = agent_core::state::AgentAppState::with_browser(
                agent_browser.clone(),
                screenshot_store.clone(),
            );
            unified_state.set_pty_sessions(pty_sessions_arc.clone());
            unified_state.set_app_handle(app.handle().clone());

            // Plan-approval lifecycle: process-wide AppHandle for terminal
            // transcript events pushed outside a live session manager, then
            // a one-shot GC pass that archives orphaned pending-plan rows
            // (missing plan file / deleted session), a repair scan that
            // restores half-committed create_plan submissions, then a scan
            // that finalizes historically stranded awaiting_user create_plan
            // events (pre-backend-finalize archives whose FE patch never
            // landed).
            agent_core::interaction::plan_approval::install_app_handle(app.handle().clone());
            tauri::async_runtime::spawn(async {
                agent_core::interaction::plan_approval::gc_orphaned_pending_plans().await;
                agent_core::interaction::plan_approval::repair_orphaned_create_plan_submissions()
                    .await;
                tokio::task::spawn_blocking(
                    crate::agent_sessions::event_pipeline::agent_core_bridge::repair_stranded_plan_events,
                );
            });

            // Install the production `MemberShutdownHook` for the
            // inbox-drain side effect that fires when the coordinator
            // accepts a member's `ShutdownResponse{accepted=true}`.
            // The hook resolves `(member_agent_id, run_id) →
            // session_id` via the org store and dispatches an
            // `AgentState::cancel_session`.
            agent_core::core::session::turn::inbox_drain::install_member_shutdown_hook(
                agent_core::tools::impls::orchestration::member_shutdown::AppHandleMemberShutdownHook::new(
                    app.handle().clone(),
                ),
            );
            tracing::info!("[InboxDrain] Member shutdown hook installed");

            // Install the production `MemberIdleHook` so every worker
            // turn-end (success or cancel) posts a `MemberIdle`
            // envelope into the coordinator's inbox and wakes the
            // coordinator to keep draining open org work.
            agent_core::core::session::turn::member_idle::install_member_idle_hook(
                agent_core::tools::impls::orchestration::member_idle::InboxStoreMemberIdleHook::new(
                    agent_core::tools::impls::orchestration::inbox_wake::AppHandleInboxWakeHook::new(
                        app.handle().clone(),
                    ),
                ),
            );
            tracing::info!("[MemberIdle] Member idle hook installed");

            app.manage(unified_state);
            tracing::info!("[UnifiedAgent] Unified agent state initialized");

            // Spawn work item schedule executor
            {
                let scheduler_handle = app.handle().clone();
                agent_core::coordination::work_item_scheduler::spawn(scheduler_handle);
                tracing::info!("[scheduler] Work item scheduler started");
            }

            // Migrate legacy work-item cron schedules into routines, then
            // spawn the routine trigger scheduler.
            {
                let routine_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match tokio::task::spawn_blocking(
                        agent_core::coordination::work_item_scheduler::migrate_cron_schedules,
                    )
                    .await
                    {
                        Ok(Ok(0)) => {}
                        Ok(Ok(count)) => tracing::info!(
                            "[scheduler] Migrated {} work item cron schedules to routines",
                            count
                        ),
                        Ok(Err(err)) => tracing::warn!(
                            "[scheduler] work item cron→routine migration failed: {}",
                            err
                        ),
                        Err(err) => tracing::warn!(
                            "[scheduler] cron→routine migration join error: {}",
                            err
                        ),
                    }
                    agent_core::coordination::routine_scheduler::spawn(routine_handle);
                    tracing::info!("[scheduler] Routine scheduler started");
                });
            }

            // Spawn pluggable sync worker. Drains `outbox_entries`
            // rows on the configured push tick and runs a pull cycle
            // on the longer pull tick. The AppHandle is stashed via
            // `sync::events::init_emitter` so every cycle can emit
            // `orgii-project-sync-status` events to the frontend.
            project_management::sync::start_worker(app.handle().clone());
            tracing::info!("[sync::worker] Sync worker started");

            // Restore previously-enabled channels (e.g. feishu was toggled on last run)
            let app_handle_for_restore = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app_handle_for_restore.state::<agent_core::state::AgentAppState>();
                match agent_core::state::commands::channel_handler::restore_enabled_channels(&state)
                    .await
                {
                    Ok(()) => tracing::info!("Enabled channels restored"),
                    Err(err) => tracing::error!("Failed to restore channels: {err}"),
                }
            });

            // Ensure agent session (SDE) DB tables exist. The database schema
            // dispatcher owns the full foundation + unified session migration chain.
            if let Err(err) = agent_core::persistence::session_snapshots::ensure_tables() {
                tracing::warn!(error = %err, "[agent_session] Failed to create tables");
            }
            tracing::info!("[agent_session] Agent session state initialized with shared PTY");

            tauri::async_runtime::spawn(run_worktree_cleanup_loop());

            // One-time migration: pull workspace-memory files out of the old
            // nested `~/.orgii/personal/workspace/.orgii/workspace-memory/` into
            // the flat `~/.orgii/personal/workspace-memory/` location now used
            // by `memory_dir()`. Idempotent — no-op once the legacy dir is
            // gone. See `agent_core::memory::workspace_memory::memory_dir`.
            tauri::async_runtime::spawn(async {
                match agent_core::memory::workspace_memory::migrate_personal_workspace_memory(
                ) {
                    Ok(0) => {}
                    Ok(moved) => tracing::info!(
                        "[startup] Migrated {} personal-workspace memory file(s) to {}",
                        moved,
                        app_paths::personal_root()
                            .join("workspace-memory")
                            .display()
                    ),
                    Err(err) => tracing::warn!(
                        "[startup] Failed to migrate personal-workspace memory: {}",
                        err
                    ),
                }
            });

            // Prune orphan per-session file-history directories whose owning
            // session no longer exists in the DB. This replaces the legacy
            // shadow-git prune.
            tauri::async_runtime::spawn(async {
                let conn = match database::db::get_connection() {
                    Ok(conn) => conn,
                    Err(err) => {
                        tracing::warn!(
                            "[startup] failed to open DB for live-session query; skipping file-history prune to avoid orphan wipe: {}",
                            err
                        );
                        return;
                    }
                };
                let mut stmt = match conn.prepare("SELECT session_id FROM agent_sessions") {
                    Ok(stmt) => stmt,
                    Err(err) => {
                        tracing::warn!(
                            "[startup] failed to prepare live-session query; skipping file-history prune to avoid orphan wipe: {}",
                            err
                        );
                        return;
                    }
                };
                let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
                    Ok(rows) => rows,
                    Err(err) => {
                        tracing::warn!(
                            "[startup] failed to run live-session query; skipping file-history prune to avoid orphan wipe: {}",
                            err
                        );
                        return;
                    }
                };
                let live_ids: Vec<String> = match rows.collect::<Result<Vec<_>, _>>() {
                    Ok(ids) => ids,
                    Err(err) => {
                        tracing::warn!(
                            "[startup] failed to decode live-session rows; skipping file-history prune to avoid orphan wipe: {}",
                            err
                        );
                        return;
                    }
                };
                match agent_core::tools::file_history::prune_orphan_sessions(&live_ids) {
                    Ok(0) => {}
                    Ok(n) => {
                        tracing::info!("[startup] Pruned {} orphan file-history session(s)", n)
                    }
                    Err(err) => tracing::warn!(
                        "[startup] Failed to prune orphan file-history sessions: {}",
                        err
                    ),
                }
            });

            // Deferred background housekeeping. Waits
            // DEFERRED_CLEANUP_DELAY_SECS after boot so we don't compete
            // with startup I/O, then runs one pass over file-history TTL,
            // per-session manifest caps, and log file retention.
            tauri::async_runtime::spawn(async {
                tokio::time::sleep(std::time::Duration::from_secs(
                    infrastructure::housekeeping::DEFERRED_CLEANUP_DELAY_SECS,
                ))
                .await;
                tokio::task::spawn_blocking(|| {
                    let _ = infrastructure::housekeeping::run_deferred_cleanup();
                });
            });

            // Load skill env vars from ~/.orgii/skill-env.json into the process
            agent_core::skills::loader::load_and_apply_skill_env();

            // Initialize cursor_ide streaming delta watch state
            app.manage(cursor_ide_watch::WatchHandlesState::new());
            tracing::info!("[CursorIdeWatch] Watch handles state initialized");

            // Initialize MCP state
            app.manage(agent_core::mcp::commands::McpState::new());
            tracing::info!("[MCP] MCP server manager initialized");

            // Agent Definitions and Orgs

            // Manage the process-wide store singletons. Library code that
            // has no AppHandle reaches the SAME instances via
            // `definitions_store()` / `orgs_store()` — one in-memory state,
            // no per-call disk re-reads.
            app.manage(agent_core::definitions::definitions_store());
            tracing::info!("[AgentDefinitions] Custom agent definitions loaded");

            // Every store mutation (RPC commands, skills_toggle, the
            // manage_agent_def LLM tool) flows through the store
            // chokepoints, which fire this hook — frontend atoms refresh
            // on the event instead of manual post-mutation polling.
            {
                let handle = app.handle().clone();
                agent_core::definitions::set_definitions_changed_hook(move |agent_id| {
                    use tauri::Emitter;
                    let _ = handle.emit(
                        "orgii-agent-defs-changed",
                        serde_json::json!({ "agentId": agent_id }),
                    );
                });
            }

            app.manage(agent_core::definitions::orgs::orgs_store());
            tracing::info!("[AgentOrgs] Agent organizations loaded");

            // Initialize Settings state and file watcher
            let settings_state = settings::SettingsState::new();
            match settings::watcher::start_watching(app.handle().clone()) {
                Ok(handle) => {
                    match settings_state.watcher_handle.lock() {
                        Ok(mut watcher_handle) => {
                            *watcher_handle = Some(handle);
                            tracing::info!("[Settings] File watcher started for ~/.orgii/settings.jsonc");
                        }
                        Err(err) => {
                            tracing::error!(error = %err, "[Settings] Failed to lock watcher handle");
                        }
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "[Settings] Failed to start file watcher");
                }
            }
            app.manage(settings_state);

            // System power state — holds the platform sleep-inhibitor handle
            // while at least one agent session is actively working AND the
            // `general.preventSleepWhileRunning` setting is enabled.
            app.manage(system_services::power::PowerState::new());

            // Apply HTTP version preference from settings.jsonc so the
            // provider HTTP clients (created lazily per-session) honor it.
            if let Ok(settings) = settings::file_io::read_settings() {
                if let Some(val) = settings.get("network.httpVersion").and_then(|v| v.as_str()) {
                    let pref = agent_core::utils::HttpVersionPref::from_setting(val);
                    agent_core::utils::set_global_http_version_pref(pref);
                    tracing::info!(http_version = val, "[Network] HTTP version preference applied");
                }
            }

            if dev_startup_debug_enabled() {
                app.listen("orgii-startup-first-paint", |event| {
                    println!("[TauriStartup] frontend first paint ready {}", event.payload());
                    tracing::info!(payload = event.payload(), "[TauriStartup] frontend first paint ready");
                });
            }

            // tauri_plugin_log removed — tracing_subscriber handles file logging.
            Ok(())
        })
        // Release keeps the historical behavior: closing the main window hides it so
        // tray/dock entry points can reopen it. Debug Linux/Windows exits normally
        // so dev runs do not leave hidden app processes behind.
        .on_window_event(|_window, _event| {
            if let tauri::WindowEvent::CloseRequested { api: _api, .. } = _event {
                // Only hide the "main" window — let auxiliary windows close normally
                if _window.label() == "main" {
                    #[cfg(any(target_os = "macos", not(debug_assertions)))]
                    {
                        _api.prevent_close();
                        let _ = _window.hide();
                    }
                }
            }
        })
        .on_page_load(|webview, payload| {
            use tauri::webview::PageLoadEvent;
            if webview.label() == "main" {
                let event_label = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                if dev_startup_debug_enabled() {
                    println!(
                        "[TauriPageLoad] label={} event={} url={}",
                        webview.label(),
                        event_label,
                        payload.url()
                    );
                    tracing::info!(
                        label = webview.label(),
                        event = event_label,
                        url = %payload.url(),
                        "[TauriPageLoad]"
                    );
                }
            }
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Started) {
                let app = webview.app_handle().clone();
                match browser::inline::close_all_inline_webviews(app) {
                    Ok(closed) if !closed.is_empty() => {
                        tracing::info!(count = closed.len(), ?closed, "[PageReload] Closed inline webviews");
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "[PageReload] Failed to close inline webviews");
                    }
                    _ => {}
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|err| {
            tracing::error!(error = %err, "error while building tauri application");
            std::process::exit(1);
        })
        .run(|app_handle, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = &app_handle;

            match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    tracing::info!(count = urls.len(), "[OpenedFiles] Ignoring native macOS open event");
                }
                // macOS: clicking the dock icon when all windows are closed should reopen the main window
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    if !has_visible_windows {
                        if let Err(err) = app_window::recreate_main_window(app_handle) {
                            tracing::error!(error = %err, "[Reopen] Failed to recreate main window");
                        }
                    }
                }
                // Release keeps the process alive when all windows are hidden.
                // Debug Linux/Windows exits normally when the last window closes.
                // code.is_none() means it's an automatic exit (last window closed), not an explicit exit(0).
                tauri::RunEvent::ExitRequested {
                    api: _api, code, ..
                } => {
                    #[cfg(any(target_os = "macos", not(debug_assertions)))]
                    if code.is_none() {
                        _api.prevent_exit();
                        return;
                    }

                    if code.is_some()
                        || cfg!(all(debug_assertions, not(target_os = "macos")))
                    {
                        // Explicit exit — mark active orchestrator workflows as interrupted
                        agent_core::coordination::work_item_recovery::mark_all_interrupted_sync();
                        // Release computer-use lock if held
                        integrations::computer_use_lock::force_release_on_exit();
                    }
                }
                _ => {}
            }
        });
}
