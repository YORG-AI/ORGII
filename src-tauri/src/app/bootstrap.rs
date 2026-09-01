//! Process bootstrap that runs before the Tauri builder is assembled.
//!
//! Owns the platform environment guards, runtime-instance data roots, IoC hook
//! and bridge registration, startup recovery, tracing initialization, and the
//! panic hook — everything that must already be in place before the first
//! Tauri plugin or the `setup` hook runs.

use crate::runtime_instance;
use crate::setup::*;

#[cfg(target_os = "macos")]
use crate::single_instance_focus;

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

pub(crate) fn dev_startup_debug_enabled() -> bool {
    std::env::var("ORGII_DEV_STARTUP_DEBUG").as_deref() == Ok("true")
}

/// Linux-only env guards that cap WebKitGTK CPU during streaming/output (issue
/// #227): disable GPU compositing mode and bound llvmpipe (software GL) to two
/// threads. Gated to Linux because the symbols are unused on other platforms —
/// without `#[cfg(target_os = "linux")]`, macOS `cargo clippy -- -D warnings`
/// (CI runs on macos-latest) would reject them as dead code.
#[cfg(target_os = "linux")]
const LINUX_WEBKIT_CPU_GUARD_ENV: &[(&str, &str)] = &[
    ("WEBKIT_DISABLE_COMPOSITING_MODE", "1"),
    ("LP_NUM_THREADS", "2"),
];

#[cfg(target_os = "linux")]
fn linux_webkit_cpu_guard_value(key: &str, current_value: Option<&str>) -> Option<&'static str> {
    if current_value.is_some() {
        return None;
    }
    LINUX_WEBKIT_CPU_GUARD_ENV
        .iter()
        .find_map(|(guard_key, guard_value)| (*guard_key == key).then_some(*guard_value))
}

#[cfg(target_os = "linux")]
fn apply_linux_webkit_cpu_guards() {
    for (key, _) in LINUX_WEBKIT_CPU_GUARD_ENV {
        if let Some(value) = linux_webkit_cpu_guard_value(
            key,
            std::env::var_os(key).as_deref().and_then(|v| v.to_str()),
        ) {
            std::env::set_var(key, value);
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn apply_linux_webkit_cpu_guards() {}

/// Runs every process-level initialization step that must precede the Tauri
/// builder, given the identifier embedded in the generated Tauri context.
pub(crate) fn bootstrap(identifier: &str) {
    // A second launch on macOS (e.g. clicking the installed app while a dev
    // instance is running) must hand focus to the primary instance from THIS
    // process: since macOS 14 the primary cannot activate itself from the
    // background, so the single-instance callback's show/focus is silently
    // ignored and the click looks dead. This process still owns the user's
    // activation intent, so activate the primary before the single-instance
    // plugin forwards argv to it and exits this process.
    #[cfg(target_os = "macos")]
    single_instance_focus::activate_running_instance(identifier);

    let runtime_profile = runtime_instance::RuntimeInstanceProfile::from_identifier(identifier);
    if std::env::var_os("ORGII_HOME").is_none() {
        if let Some(data_home) = runtime_profile.default_orgii_home(&app_paths::home_dir()) {
            std::env::set_var("ORGII_HOME", data_home);
        }
    }
    if std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME").is_none() {
        let resolved_orgii_home = app_paths::orgii_root();
        if let Some(external_history_home) =
            runtime_profile.default_external_history_home(&resolved_orgii_home)
        {
            std::env::set_var("ORGII_EXTERNAL_HISTORY_HOME", external_history_home);
        }
    }

    apply_linux_webkit_cpu_guards();

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
    agent_core::session::housekeeper_compaction::refresh_global_config_from_disk();

    // Wire `integrations::computer_use_lock`'s abort broadcaster so the ESC
    // hotkey can fan an event out to the frontend without the `integrations`
    // crate depending on `agent_core::bus`.
    register_integrations_hooks();

    // Wire the agent_core bus IoC pointers (frontend broadcast +
    // subscriber-count) so `agent_core::bus::broadcast_event` and
    // `ActionBridge::has_frontend` can reach the IDE WebSocket / IPC layer
    // without depending back into `api::websocket_handler`.
    register_agent_core_bus_hooks();

    // Wire the event-pipeline bridge so `agent_core` can drive the live
    // `EventStore` (push events, notify, stamp tool_call args, pin/unpin
    // child sessions, flush streaming) without depending on
    // `agent_sessions::event_pipeline::commands`.
    register_event_pipeline_bridge();

    // A process crash can leave the last append-only shell frame torn and
    // its manifest marked `running`. Repair indexes before any Session can be
    // replayed, and make every such artifact explicitly incomplete.
    match agent_core::tools::impls::coding::exec::shell_replay::recover_incomplete_replays() {
        Ok(0) => {}
        Ok(count) => tracing::info!(count, "recovered incomplete shell replay artifacts"),
        Err(err) => tracing::warn!(error = %err, "shell replay startup recovery failed"),
    }
    match agent_core::tools::impls::coding::exec::shell_replay::retry_pending_replay_cleanups() {
        Ok((0, 0)) => {}
        Ok((completed, failed)) => tracing::info!(
            completed,
            failed,
            "processed pending shell replay cleanup jobs"
        ),
        Err(err) => tracing::warn!(error = %err, "shell replay cleanup recovery failed"),
    }

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
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux_webkit_cpu_guard_value;

    #[test]
    fn linux_webkit_cpu_guard_sets_missing_known_keys() {
        assert_eq!(
            linux_webkit_cpu_guard_value("WEBKIT_DISABLE_COMPOSITING_MODE", None),
            Some("1")
        );
        assert_eq!(
            linux_webkit_cpu_guard_value("LP_NUM_THREADS", None),
            Some("2")
        );
    }

    #[test]
    fn linux_webkit_cpu_guard_preserves_explicit_values() {
        assert_eq!(
            linux_webkit_cpu_guard_value("LP_NUM_THREADS", Some("4")),
            None
        );
    }

    #[test]
    fn linux_webkit_cpu_guard_ignores_unknown_keys() {
        assert_eq!(linux_webkit_cpu_guard_value("OTHER_ENV", None), None);
    }
}
