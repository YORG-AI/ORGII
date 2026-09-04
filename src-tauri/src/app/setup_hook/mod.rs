//! The Tauri `.setup()` hook, split into ordered initialization stages.
//!
//! Stage order is behavior: each stage runs exactly where its code ran inside
//! the original single `setup` closure, so never reorder the calls below.

pub(crate) mod background;
pub(crate) mod services;
pub(crate) mod state;
pub(crate) mod window;

/// Runs every backend initialization stage, in order, once Tauri has created
/// the application instance.
pub(crate) fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Python sidecar removed — all backend logic now in Rust.

    let runtime_profile = window::init_runtime_profile_and_window(app)?;
    services::start_backend_services(app, runtime_profile);
    state::init_core_state(app);
    background::spawn_background_workers(app);
    state::init_settings_and_stores(app);

    // tauri_plugin_log removed — tracing_subscriber handles file logging.
    Ok(())
}
