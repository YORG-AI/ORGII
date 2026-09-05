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
            // Apply chrome while the window is still hidden (visible:false in
            // tauri.conf.json), so the pre-chrome frames never reach the
            // screen.
            app_window::apply_host_desktop_window_chrome(&main_window);

            // Same contract as `open_session_window`: reposition the traffic
            // lights, mount the vibrancy material, then clear the config's
            // opaque backdrop and pin the webview to transparent so it
            // composites onto that material from its very first frame.
            //
            // The main window SETTLES on this vibrancy — the
            // `html[data-host-desktop="macos"]` rule in src/index.scss paints
            // only a 15% tint over it — so vibrancy is also its honest
            // pre-paint surface. The old `apply_window_background_color`
            // instead enabled WKWebView background drawing under a #0d0d0d
            // plate, index.html then painted the opaque --splash-bg plate
            // (#ffffff on a light theme) on top for the whole bundle boot,
            // and the bundle's post-paint `remove_window_background` dropped
            // both in one frame: transparent, then white, then vibrancy.
            // index.html keeps the plate off macOS windows to match.
            //
            // Shown once the chrome is in place rather than deferred to
            // first paint: with nothing opaque left to flash, the splash
            // mark over the material is the first frame. The show itself is
            // enqueued behind tao's asynchronous `maximized` zoom (see
            // `show_after_queued_native_layout`) so that first frame is
            // already full-size instead of jumping from 1200×800.
            #[cfg(target_os = "macos")]
            {
                app_window::set_traffic_light_position(
                    &main_window,
                    app_window::TRAFFIC_LIGHT_X,
                    app_window::TRAFFIC_LIGHT_Y,
                );
                app_window::apply_macos_window_material(&main_window);
                app_window::remove_window_background_color(&main_window);
                app_window::show_after_queued_native_layout(&main_window);
            }
        }

        // On Windows and Linux the main window also starts hidden
        // (visible:false in tauri.conf.json). With transparent:true, set_background_color
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
