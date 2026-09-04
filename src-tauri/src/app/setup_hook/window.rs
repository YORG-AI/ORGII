//! Setup stage 1: resolve the runtime instance profile and bring the main
//! window into its presentable state (chrome, traffic lights, deferred show).

// `Manager` stays imported inside the two blocks below, exactly as it was in
// the original setup closure — `App::config` and `App::handle` are inherent.

#[cfg(not(target_os = "macos"))]
use tauri::Listener;

use crate::runtime_instance;

pub(crate) fn init_runtime_profile_and_window(
    app: &tauri::App,
) -> Result<runtime_instance::RuntimeInstanceProfile, Box<dyn std::error::Error>> {
    // The Tauri identifier is embedded in each built binary and is
    // therefore available even when the executable is launched
    // directly. Use it as the runtime source of truth for ports;
    // launcher env vars remain optional overrides for diagnostics.
    let runtime_profile =
        runtime_instance::RuntimeInstanceProfile::from_identifier(
            &app.config().identifier,
        );
    if !agent_cli::managed_config::set_managed_proxy_port_default(
        runtime_profile.cli_proxy_port,
    ) {
        tracing::warn!(
            requested_port = runtime_profile.cli_proxy_port,
            "[Runtime Instance] CLI proxy default was already configured"
        );
    }
    tracing::info!(
        instance_id = runtime_profile.instance_id,
        identifier = %app.config().identifier,
        ide_server_port = runtime_profile.ide_server_port,
        cli_proxy_port = runtime_profile.cli_proxy_port,
        "[Runtime Instance] resolved isolated service defaults"
    );

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
            // Apply chrome while the window is still hidden.
            app_window::apply_host_desktop_window_chrome(&main_window);

            #[cfg(target_os = "macos")]
            {
                app_window::apply_window_background_color(&main_window);
                app_window::set_traffic_light_position(
                    &main_window,
                    app_window::TRAFFIC_LIGHT_X,
                    app_window::TRAFFIC_LIGHT_Y,
                );
                app_window::apply_macos_window_material(&main_window);
                let _ = main_window.show();
                let _ = main_window.set_focus();
            }
        }

        // On Windows the main window starts hidden (visible:false in the
        // platform config). With transparent:true, set_background_color
        // is a visual no-op — WebView2 composites directly over the
        // transparent surface, so showing the window before the webview
        // has painted exposes DWM/WebView2 edge artifacts (thin black
        // lines around the border on Win10). We defer show() until the
        // frontend emits "orgii:main-window-ready", which fires once
        // the splash HTML has loaded and painted.
        #[cfg(not(target_os = "macos"))]
        {
            let show_handle = app.handle().clone();
            app.handle().listen(
                "orgii:main-window-ready",
                move |_| {
                    if let Some(w) = show_handle.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                },
            );

            // Safety fallback: if the frontend event never arrives
            // (bundle crash, IPC failure), show after 3 s so the user
            // is never stranded on a hidden window.
            let timeout_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if let Some(w) = timeout_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            });
        }
    }

    Ok(runtime_profile)
}
