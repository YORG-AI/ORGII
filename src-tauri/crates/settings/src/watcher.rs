//! Settings File Watcher
//!
//! Watches `~/.orgii/settings.jsonc` for external changes (e.g., agent edits)
//! and emits a Tauri event so the frontend can reload.
//!
//! Uses the `notify` crate (already a dependency) with debouncing.

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tracing::{error, info, warn};

use super::file_io;

/// Event name emitted to the frontend when the settings file changes externally.
pub const SETTINGS_CHANGED_EVENT: &str = "settings-file-changed";

/// Event name emitted when the settings file is deleted.
pub const SETTINGS_DELETED_EVENT: &str = "settings-file-deleted";

/// Handle to the watcher thread. Dropping this stops the watcher.
pub struct SettingsWatcherHandle {
    /// Signal to stop the watcher thread
    stop_signal: Arc<AtomicBool>,
    /// Thread handle (joined on drop)
    _thread: std::thread::JoinHandle<()>,
}

impl Drop for SettingsWatcherHandle {
    fn drop(&mut self) {
        self.stop_signal.store(true, Ordering::Relaxed);
        // Thread will exit on next event or timeout
    }
}

/// Start watching the settings file for changes.
/// Returns a handle that keeps the watcher alive.
pub fn start_watching(app_handle: AppHandle) -> Result<SettingsWatcherHandle, String> {
    let settings_path = file_io::get_settings_path();

    let settings_dir = settings_path
        .parent()
        .ok_or("Settings path has no parent directory")?
        .to_path_buf();

    // Ensure the directory exists so we can watch it
    std::fs::create_dir_all(&settings_dir)
        .map_err(|err| format!("Failed to create settings dir for watcher: {err}"))?;

    let stop_signal = Arc::new(AtomicBool::new(false));
    let stop_clone = stop_signal.clone();

    let thread = std::thread::spawn(move || {
        if let Err(err) = watcher_loop(app_handle, settings_dir, settings_path, stop_clone) {
            error!(error = %err, "settings watcher stopped with error");
        }
    });

    Ok(SettingsWatcherHandle {
        stop_signal,
        _thread: thread,
    })
}

/// Internal watcher loop that runs on a dedicated thread.
fn watcher_loop(
    app_handle: AppHandle,
    watch_dir: PathBuf,
    settings_path: PathBuf,
    stop_signal: Arc<AtomicBool>,
) -> Result<(), String> {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = RecommendedWatcher::new(
        move |result| {
            let _ = tx.send(result);
        },
        Config::default().with_poll_interval(Duration::from_secs(2)),
    )
    .map_err(|err| format!("Failed to create file watcher: {err}"))?;

    watcher
        .watch(&watch_dir, RecursiveMode::NonRecursive)
        .map_err(|err| format!("Failed to watch settings directory: {err}"))?;

    info!(path = %settings_path.display(), "settings watcher started");

    // Simple debounce: skip events within 500ms of the last processed event
    let mut last_event_time = std::time::Instant::now() - Duration::from_secs(10);

    loop {
        if stop_signal.load(Ordering::Relaxed) {
            info!("settings watcher stopped");
            break;
        }

        // Wait for events with a timeout so we can check the stop signal
        match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(event)) => {
                // Only process events for our settings file
                let affects_settings = event.paths.iter().any(|path| {
                    path.file_name()
                        .map(|name| name == "settings.jsonc")
                        .unwrap_or(false)
                });

                if !affects_settings {
                    continue;
                }

                // Debounce: ignore events within 500ms of the last one
                let now = std::time::Instant::now();
                if now.duration_since(last_event_time) < Duration::from_millis(500) {
                    continue;
                }
                last_event_time = now;

                match event.kind {
                    EventKind::Remove(_) => {
                        info!("settings file deleted");
                        if let Err(err) = app_handle.emit(SETTINGS_DELETED_EVENT, ()) {
                            error!(error = %err, "failed to emit settings delete event");
                        }
                    }
                    EventKind::Create(_) | EventKind::Modify(_) => {
                        info!("settings file changed");
                        match file_io::read_settings() {
                            Ok(settings) => {
                                super::hooks::on_settings_changed(&settings);

                                if let Err(err) = app_handle.emit(SETTINGS_CHANGED_EVENT, &settings)
                                {
                                    error!(error = %err, "failed to emit settings change event");
                                }
                            }
                            Err(err) => {
                                warn!(error = %err, "failed to read settings after change");
                            }
                        }
                    }
                    _ => {
                        // Access, other events — ignore
                    }
                }
            }
            Ok(Err(err)) => {
                warn!(error = %err, "settings watcher event error");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Normal timeout, loop back and check stop_signal
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                info!("settings watcher channel disconnected");
                break;
            }
        }
    }

    Ok(())
}
