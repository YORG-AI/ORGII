//! Setup stage 4: spawn the background workers and one-shot startup jobs —
//! work-item dispatch and scheduling, routine migration, the cross-process PM
//! watermark poller, project sync, and deferred housekeeping/migrations.

use tauri::Manager;

use crate::infrastructure;
use crate::setup::run_worktree_cleanup_loop;

pub(crate) fn spawn_background_workers(app: &tauri::App) {
    // Durable WorkItemRun outbox consumer. This starts before the
    // legacy schedulers so every producer can converge on one
    // crash-safe delivery path during migration.
    agent_core::coordination::work_item_run_dispatcher::spawn(app.handle().clone());
    tracing::info!("[work-run-dispatcher] started");

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
            // Orgtrack migration: convert legacy RoutineDefinitions
            // into portable pm_routines specs. Converted legacy rows
            // are disabled in the same pass so the legacy scheduler
            // can never double-fire them; the written report lands
            // next to the store for the operator.
            match tokio::task::spawn_blocking(|| {
                project_management::routine_service::convert::convert_all(true)
            })
            .await
            {
                Ok(Ok(report)) => {
                    if !report.converted.is_empty() || !report.skipped.is_empty() {
                        tracing::info!(
                            "[routine-migration] converted {} legacy routines, skipped {}",
                            report.converted.len(),
                            report.skipped.len()
                        );
                        let path = app_paths::orgii_root()
                            .join("routine-conversion-report.json");
                        if let Ok(raw) = serde_json::to_string_pretty(&report) {
                            let _ = std::fs::write(path, raw);
                        }
                    }
                }
                Ok(Err(err)) => tracing::warn!(
                    "[routine-migration] legacy routine conversion failed: {}",
                    err
                ),
                Err(err) => tracing::warn!(
                    "[routine-migration] conversion join error: {}",
                    err
                ),
            }
            agent_core::coordination::routine_scheduler::spawn(routine_handle);
            tracing::info!("[scheduler] Routine scheduler started");
        });
    }

    // Cross-process PM change watermark poller: external writers
    // (the org2 PM CLI) bump pm_change_seq inside every mutation
    // transaction; the desktop notices via this cheap single-row
    // poll and refreshes the UI (design 13.0).
    {
        let watermark_handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            use tauri::Emitter;
            const STAGE_BARRIER_CONSUMER: &str = "stage_barrier_dispatch_v1";
            let initial_seq = tokio::task::spawn_blocking(
                project_management::projects::io::read_pm_change_seq,
            )
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(0)
            .max(0);
            let mut last_seq = initial_seq;
            let mut stage_cursor = tokio::task::spawn_blocking(move || {
                project_management::work_run_service::initialize_consumer_cursor(
                    STAGE_BARRIER_CONSUMER,
                    initial_seq,
                )
            })
            .await
            .ok()
            .and_then(Result::ok)
            .unwrap_or(initial_seq);
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let seq = tokio::task::spawn_blocking(
                    project_management::projects::io::read_pm_change_seq,
                )
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or(-1);
                if seq >= 0 && seq != last_seq {
                    // The same durable watermark covers WorkItemRun
                    // outbox writes made by another desktop/CLI
                    // process. Wake the dispatcher; its read-only
                    // readiness probe avoids a writer lock for PM
                    // changes unrelated to dispatch.
                    agent_core::coordination::work_item_run_dispatcher::wake_from_watermark();
                    let _ = watermark_handle.emit(
                        project_management::projects::events::DATA_CHANGED_EVENT,
                        serde_json::json!({ "source": "pm-watermark" }),
                    );
                }
                if seq > stage_cursor {
                    match agent_core::coordination::child_done_wake::process_audit_window(
                        &watermark_handle,
                        stage_cursor,
                    )
                    .await
                    {
                        Ok(_) => {
                            let through_seq = seq;
                            match tokio::task::spawn_blocking(move || {
                                project_management::work_run_service::advance_consumer_cursor(
                                    STAGE_BARRIER_CONSUMER,
                                    through_seq,
                                )
                            })
                            .await
                            {
                                Ok(Ok(cursor)) => stage_cursor = cursor,
                                Ok(Err(err)) => tracing::warn!(
                                    "[child-done-wake] cursor advance failed: {}",
                                    err
                                ),
                                Err(err) => tracing::warn!(
                                    "[child-done-wake] cursor task failed: {}",
                                    err
                                ),
                            }
                        }
                        Err(err) => tracing::warn!(
                            "[child-done-wake] audit window failed: {}",
                            err
                        ),
                    }
                }
                if seq >= 0 {
                    last_seq = seq;
                }
            }
        });
    }

    // Spawn pluggable sync worker. Drains `outbox_entries`
    // rows on the configured push tick and runs a pull cycle
    // on the longer pull tick. The AppHandle is stashed via
    // `sync::events::init_emitter` so every cycle can emit
    // `orgii-project-sync-status` events to the frontend.
    project_management::sync::start_worker(app.handle().clone());
    tracing::info!("[sync::worker] Sync worker started");

    let data_changed_handle = app.handle().clone();
    project_management::projects::events::register_data_changed_notifier(Box::new(
        move || {
            use tauri::Emitter;
            let _ = data_changed_handle.emit(
                project_management::projects::events::DATA_CHANGED_EVENT,
                serde_json::json!({ "source": "rust" }),
            );
        },
    ));

    // Child-done parent wake: when the last open
    // sub-item settles, note the parent's Discussion and resume its
    // linked session with the barrier summary.
    agent_core::coordination::child_done_wake::register(app.handle().clone());

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
}
