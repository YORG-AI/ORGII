//! Application lifecycle handlers wired into the Tauri builder: window events,
//! page loads, and the process-level run-event loop (including shutdown).

use tauri::Manager;

use crate::app::bootstrap::dev_startup_debug_enabled;
use crate::benchmark;

/// Keeps the macOS traffic lights pinned after scale-factor, theme, and focus
/// changes.
pub(crate) fn sync_traffic_lights_on_window_event(
    _window: &tauri::Window,
    _event: &tauri::WindowEvent,
) {
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
}

// Release keeps the historical behavior: closing the main window hides it so
// tray/dock entry points can reopen it. Debug Linux/Windows exits normally
// so dev runs do not leave hidden app processes behind.
pub(crate) fn handle_window_close_and_destroy(
    _window: &tauri::Window,
    _event: &tauri::WindowEvent,
) {
    // A destroyed window may never run its JS cleanup (crash, direct
    // programmatic close of a detached session window). Drop its
    // sleep-inhibitor holder so the process-wide assertion is
    // refcounted correctly — neither leaked until process exit nor
    // still attributed to a dead window.
    if let tauri::WindowEvent::Destroyed = _event {
        system_services::power::release_sleep_inhibitor_for_window_label(_window.label());
    }
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
}

/// Main-webview page-load hook: dev startup tracing plus inline-webview
/// teardown on reload.
pub(crate) fn handle_page_load(
    webview: &tauri::Webview,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
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
}

/// Process-level run-event loop: macOS open/reopen behavior and the ordered
/// shutdown sequence on exit.
pub(crate) fn handle_run_event(app_handle: &tauri::AppHandle, event: tauri::RunEvent) {
    #[cfg(not(target_os = "macos"))]
    let _ = &app_handle;

    match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            tracing::info!(
                count = urls.len(),
                "[OpenedFiles] Ignoring native macOS open event"
            );
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
            api: _api,
            code: _code,
            ..
        } => {
            #[cfg(any(target_os = "macos", not(debug_assertions)))]
            if _code.is_none() {
                _api.prevent_exit();
                return;
            }

            match agent_cli::managed_config::restore_managed_configs_for_shutdown() {
                Ok(report) => {
                    if !report.restored_agents.is_empty() {
                        tracing::info!(
                            agents = ?report.restored_agents,
                            "[CLI Managed Config] restored Default configs before exit"
                        );
                    }
                    for (agent, error) in report.failed_agents {
                        tracing::warn!(
                            agent,
                            error = %error,
                            "[CLI Managed Config] left config unchanged during exit"
                        );
                    }
                }
                Err(error) => tracing::warn!(
                    error = %error,
                    "[CLI Managed Config] failed to run shutdown restoration"
                ),
            }
            // Explicit exit — mark active orchestrator workflows as interrupted
            agent_core::coordination::work_item_recovery::mark_all_interrupted_sync();
            // Release computer-use lock if held
            integrations::computer_use_lock::force_release_on_exit();
            // Kill all PTY shells and (on Unix) their whole process
            // sessions — HUP-immune descendants would otherwise leak
            // past app exit.
            app_handle
                .state::<::terminal::pty_commands::pty::PtyState>()
                .shutdown_kill_all();
            // Terminate benchmark evaluator subprocesses still running so
            // they don't outlive the app as orphans.
            benchmark::terminate_running_evaluators_sync();
        }
        _ => {}
    }
}
