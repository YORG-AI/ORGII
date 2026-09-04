//! Tauri builder construction: plugin registration order, the single-instance
//! / deep-link forwarding callback, and the `canvas-artifact` URI scheme.
//!
//! Plugin registration order is behavior — keep the sequence below untouched.

use tauri::Manager;

use crate::infrastructure;

/// Builds the `tauri::Builder` with every plugin, managed store, and custom URI
/// scheme registered in its original order.
pub(crate) fn configure() -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default();

    // Keep this plugin first. On Windows and Linux the OS launches a second
    // process for a custom-scheme URL; the single-instance plugin's
    // `deep-link` feature forwards that argv URL to the already-running
    // process before this callback runs. The frontend's app-lifetime
    // `onOpenUrl` listener remains the single owner of invite routing.
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // Never log argv: deep-link query/fragment values can contain invite
        // codes, share capabilities, or OAuth tokens.
        tracing::info!(
            argument_count = argv.len(),
            "external open request forwarded to the running app"
        );

        if let Some(main_window) = app.get_webview_window("main") {
            if let Err(error) = main_window.unminimize() {
                tracing::warn!(?error, "failed to restore the main window");
            }
            if let Err(error) = main_window.show() {
                tracing::warn!(?error, "failed to show the main window");
            }
            if let Err(error) = main_window.set_focus() {
                tracing::warn!(?error, "failed to focus the main window");
            }
        } else if let Err(error) = app_window::recreate_main_window(app) {
            tracing::warn!(
                %error,
                "failed to recreate the main window for an external open request"
            );
        }
    }));

    // E2E WebDriver automation — only when built with `--features webdriver` (debug/test only).
    #[cfg(all(debug_assertions, feature = "webdriver"))]
    let builder = builder.plugin(tauri_plugin_webdriver_automation::init());

    let builder = builder
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
        .plugin(tauri_plugin_drag::init());

    // Agent-generated React canvas artifacts: the frontend publishes compiled
    // artifact documents into this bounded in-memory store
    // (`canvas_artifact_publish`) and loads them back through the dedicated
    // `canvas-artifact` scheme. Serving over a real scheme gives the artifact
    // iframe its own origin and its own response CSP — the main webview policy
    // has no `unsafe-eval`/`unsafe-inline`, and srcdoc frames inherit it, so
    // generated code can only execute on a separate origin. The main CSP
    // allows the frame via `frame-src` in `tauri.conf.json`.
    let builder = builder
        .manage(infrastructure::canvas_artifacts::CanvasArtifactStore::default())
        .register_uri_scheme_protocol("canvas-artifact", |context, request| {
            let store = context
                .app_handle()
                .state::<infrastructure::canvas_artifacts::CanvasArtifactStore>();
            infrastructure::canvas_artifacts::protocol_response(&store, request.uri().path())
        });

    builder
}
