//! Native Application Menu Bar
//!
//! Creates the macOS-style menu bar with:
//! - ORGII (app menu)
//! - File > Open, Open Recent
//! - Edit (standard edit menu)
//! - View
//! - Window
//! - Help
//!
//! Recent paths are persisted to `recent_paths.json` in the Tauri app data dir
//! and restored into ORGII's app-controlled File > Open Recent menu on startup.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

/// Maximum number of recent items to show in the menu
const MAX_RECENT_ITEMS: usize = 10;

const RECENT_PATHS_FILENAME: &str = "recent_paths.json";
const MAIN_WINDOW_LABEL: &str = "main";
const EVENT_QUIT_CONFIRMATION_OPEN: &str = "native-quit-confirmation-open";
const EVENT_QUIT_CONFIRMATION_CLOSE: &str = "native-quit-confirmation-close";
const EVENT_REOPEN_SETUP: &str = "menu-reopen-setup";
const MENU_ID_RESTART_SETUP: &str = "help_restart_setup";

/// Global state for recent paths (thread-safe)
static RECENT_PATHS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static QUIT_CONFIRMATION_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Create the application menu bar
pub fn create_app_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    // ========================================
    // App Menu (ORGII)
    // ========================================
    let quit_item = MenuItem::with_id(app, "app_quit", "Quit ORGII", true, Some("CmdOrCtrl+Q"))?;

    let app_menu = SubmenuBuilder::new(app, "ORGII")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit_item)
        .build()?;

    // ========================================
    // File Menu
    // ========================================
    let new_session_item = MenuItem::with_id(
        app,
        "file_new_session",
        "New Session",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let open_folder_item = MenuItem::with_id(
        app,
        "file_open_folder",
        "Open Folder...",
        true,
        Some("CmdOrCtrl+O"),
    )?;

    // Create Open Recent submenu (non-fatal — don't break the whole menu if this fails)
    let open_recent_result = create_open_recent_submenu(app);
    if let Err(ref err) = open_recent_result {
        eprintln!("⚠️ [AppMenu] Failed to create Open Recent submenu: {}", err);
    }

    let add_folder_item = MenuItem::with_id(
        app,
        "file_add_folder_to_workspace",
        "Add Folder to Workspace...",
        true,
        None::<&str>,
    )?;
    let save_workspace_item = MenuItem::with_id(
        app,
        "file_save_workspace_as",
        "Save Workspace As...",
        true,
        None::<&str>,
    )?;

    let close_window_item = MenuItem::with_id(
        app,
        "file_close_window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    let mut file_menu_builder = SubmenuBuilder::new(app, "File")
        .item(&new_session_item)
        .separator()
        .item(&open_folder_item)
        .item(&add_folder_item);

    if let Ok(ref open_recent_submenu) = open_recent_result {
        file_menu_builder = file_menu_builder.item(open_recent_submenu);
    }

    let file_menu = file_menu_builder
        .separator()
        .item(&save_workspace_item)
        .separator()
        .item(&close_window_item)
        .build()?;

    // ========================================
    // Edit Menu (standard)
    // ========================================
    // Use a custom Select All item instead of the built-in .select_all().
    // Do not bind Cmd/Ctrl+A here: when a native child webview has focus, the
    // menu accelerator consumes the shortcut before WebKit can select page text.
    let select_all_item =
        MenuItem::with_id(app, "edit_select_all", "Select All", true, None::<&str>)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .item(&select_all_item)
        .build()?;

    // ========================================
    // View Menu
    // ========================================
    let zoom_in_item = MenuItem::with_id(app, "view_zoom_in", "Zoom In", true, None::<&str>)?;
    let zoom_out_item = MenuItem::with_id(app, "view_zoom_out", "Zoom Out", true, None::<&str>)?;
    let zoom_reset_item =
        MenuItem::with_id(app, "view_zoom_reset", "Actual Size", true, None::<&str>)?;
    let command_palette_item = MenuItem::with_id(
        app,
        "view_command_palette",
        "Command Palette",
        true,
        None::<&str>,
    )?;
    let go_to_file_item =
        MenuItem::with_id(app, "view_go_to_file", "Go to File...", true, None::<&str>)?;

    // Switch Workspace (Cmd+.) MUST live in a native menu accelerator
    // because macOS AppKit hardcodes plain Cmd+. as the system-wide
    // "Cancel" command (cancelOperation:) and never delivers the
    // keystroke to WKWebView. Registering it as a menu accelerator
    // bypasses that interception; the menu handler emits the same JS
    // event a JS keydown listener would have fired.
    //
    // The sibling shortcuts (⌥⌘., ⇧⌘., ⌘/) are NOT intercepted by
    // AppKit, but we still surface them here for discoverability so the
    // menu bar reflects every workspace/branch/location/model selector
    // shortcut the app supports.
    let switch_workspace_item = MenuItem::with_id(
        app,
        "view_switch_workspace",
        "Switch Workspace...",
        true,
        Some("CmdOrCtrl+."),
    )?;
    let switch_branch_item = MenuItem::with_id(
        app,
        "view_switch_branch",
        "Switch Branch...",
        true,
        Some("CmdOrCtrl+Alt+."),
    )?;
    let switch_location_item = MenuItem::with_id(
        app,
        "view_switch_location",
        "Switch Running Location...",
        true,
        Some("CmdOrCtrl+Shift+."),
    )?;
    let select_model_item = MenuItem::with_id(
        app,
        "view_select_model",
        "Select Model...",
        true,
        Some("CmdOrCtrl+/"),
    )?;
    let open_settings_item = MenuItem::with_id(
        app,
        "view_open_settings",
        "Settings...",
        true,
        Some("CmdOrCtrl+,"),
    )?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&command_palette_item)
        .item(&go_to_file_item)
        .item(&select_model_item)
        .item(&switch_workspace_item)
        .item(&switch_branch_item)
        .item(&switch_location_item)
        .separator()
        .item(&open_settings_item)
        .separator()
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .item(&zoom_reset_item)
        .separator()
        .fullscreen()
        .build()?;

    // ========================================
    // Window Menu (standard)
    // ========================================
    let show_work_station_item = MenuItem::with_id(
        app,
        "window_maximize_work_station",
        "Maximize Workstation",
        true,
        Some("CmdOrCtrl+Shift+M"),
    )?;
    let window_close_window_item = MenuItem::with_id(
        app,
        "window_close_window",
        "Close Window",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .item(&show_work_station_item)
        .separator()
        .fullscreen()
        .show_all()
        .separator()
        .item(&window_close_window_item)
        .build()?;

    #[cfg(target_os = "macos")]
    let _ = window_menu.set_as_windows_menu_for_nsapp();

    // ========================================
    // Help Menu
    // ========================================
    let documentation_item = MenuItem::with_id(
        app,
        "help_documentation",
        "Documentation",
        true,
        None::<&str>,
    )?;
    let report_issue_item =
        MenuItem::with_id(app, "help_report_issue", "Report Issue", true, None::<&str>)?;
    let restart_setup_item = MenuItem::with_id(
        app,
        MENU_ID_RESTART_SETUP,
        "Restart Setup Guide",
        true,
        Some("CmdOrCtrl+Alt+O"),
    )?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&restart_setup_item)
        .separator()
        .item(&documentation_item)
        .item(&report_issue_item)
        .build()?;

    // ========================================
    // Build Complete Menu
    // ========================================
    let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()?;

    Ok(menu)
}

/// Create the "Open Recent" submenu
fn create_open_recent_submenu(app: &AppHandle) -> Result<Submenu<Wry>, tauri::Error> {
    let recent_paths = RECENT_PATHS.lock().unwrap();

    let mut submenu_builder = SubmenuBuilder::new(app, "Open Recent");

    if recent_paths.is_empty() {
        // Show placeholder when no recent items
        let no_recent =
            MenuItem::with_id(app, "recent_none", "No Recent Items", false, None::<&str>)?;
        submenu_builder = submenu_builder.item(&no_recent);
    } else {
        // Add each recent path as a menu item
        for (index, path) in recent_paths.iter().take(MAX_RECENT_ITEMS).enumerate() {
            // Use just the folder/file name for display, full path as ID
            let display_name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());

            let item_id = format!("recent_{}", index);
            let item = MenuItem::with_id(app, &item_id, &display_name, true, None::<&str>)?;
            submenu_builder = submenu_builder.item(&item);
        }
    }

    // Always add "Clear Recent" at the bottom
    submenu_builder = submenu_builder.separator();
    let clear_recent = MenuItem::with_id(app, "recent_clear", "Clear Recent", true, None::<&str>)?;
    submenu_builder = submenu_builder.item(&clear_recent);

    submenu_builder.build()
}

/// Resolve the path to `recent_paths.json` inside the Tauri app data dir.
fn recent_paths_file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(RECENT_PATHS_FILENAME))
}

/// Persist the current in-memory recent paths to disk.
fn save_recent_paths_to_disk(app: &AppHandle) {
    let paths = RECENT_PATHS.lock().unwrap().clone();
    let Some(file_path) = recent_paths_file(app) else {
        return;
    };
    if let Some(parent) = file_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string(&paths) {
        Ok(json) => {
            if let Err(err) = std::fs::write(&file_path, json) {
                eprintln!("[AppMenu] Failed to write recent_paths.json: {}", err);
            }
        }
        Err(err) => {
            eprintln!("[AppMenu] Failed to serialize recent paths: {}", err);
        }
    }
}

/// Load recent paths from disk into the in-memory list.
/// Filters out paths that no longer exist and persists the cleaned list back.
fn load_recent_paths_from_disk(app: &AppHandle) -> Vec<String> {
    let Some(file_path) = recent_paths_file(app) else {
        return Vec::new();
    };
    let json = match std::fs::read_to_string(&file_path) {
        Ok(j) => j,
        Err(err) => {
            // Missing file is legitimate (first run), only warn on
            // other I/O errors so a permission flip / stat fail is
            // visible instead of silently emptying the recent list.
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(
                    path = %file_path.display(),
                    error = %err,
                    "app_menu: recent_paths read failed; recent list will be empty"
                );
            }
            return Vec::new();
        }
    };
    // A corrupt recent_paths.json silently emptied the list, and the
    // very next click would overwrite the file with `[]`, permanently
    // losing whatever recoverable entries were inside. Warn so the
    // operator notices before the next persist wipes the file.
    let raw_paths: Vec<String> = match serde_json::from_str(&json) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(
                path = %file_path.display(),
                error = %err,
                "app_menu: recent_paths JSON parse failed; recent list will be empty (next persist will OVERWRITE this file)"
            );
            Vec::new()
        }
    };

    let valid_paths: Vec<String> = raw_paths
        .iter()
        .filter(|p| std::path::Path::new(p).exists())
        .take(MAX_RECENT_ITEMS)
        .cloned()
        .collect();

    let stale_count = raw_paths.len() - valid_paths.len();

    {
        let mut recent = RECENT_PATHS.lock().unwrap();
        *recent = valid_paths.clone();
    }

    if stale_count > 0 {
        save_recent_paths_to_disk(app);
    }

    valid_paths
}

/// Initialize recent paths on app startup:
/// 1. Clear stale macOS system recent documents from older builds
/// 2. Load persisted paths from disk
/// 3. Rebuild the app-controlled File > Open Recent menu
///
/// NOTE: This runs in `.setup()`, not `.menu()`, because `app.path()` is not
/// available during `.menu()` (PathResolver is not yet initialized).
/// The menu is built twice: first empty, then rebuilt here with recent items.
pub fn initialize_recent_paths(app: &AppHandle) {
    super::system_recents::clear_system_recent_documents();

    let paths = load_recent_paths_from_disk(app);
    if paths.is_empty() {
        return;
    }

    if let Err(err) = rebuild_menu(app) {
        eprintln!(
            "[AppMenu] Failed to rebuild menu after loading recents: {}",
            err
        );
    }

    println!(
        "✅ [AppMenu] Restored {} recent path(s) from disk",
        paths.len()
    );
}

/// Add a path to the recent items list and persist to disk.
pub fn add_to_recent_menu(app: &AppHandle, path: String) {
    {
        let mut recent_paths = RECENT_PATHS.lock().unwrap();

        // Remove if already exists (to move to top)
        recent_paths.retain(|p| p != &path);

        // Add to front
        recent_paths.insert(0, path);

        // Keep only MAX_RECENT_ITEMS
        recent_paths.truncate(MAX_RECENT_ITEMS);
    }

    save_recent_paths_to_disk(app);
}

/// Get the list of recent paths
pub fn get_recent_paths() -> Vec<String> {
    RECENT_PATHS.lock().unwrap().clone()
}

/// Clear all recent items and persist to disk.
pub fn clear_recent_menu(app: &AppHandle) {
    RECENT_PATHS.lock().unwrap().clear();
    save_recent_paths_to_disk(app);
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow<Wry>> {
    app.get_webview_window(MAIN_WINDOW_LABEL)
}

fn emit_main_window(app: &AppHandle, event: &str) {
    if let Some(window) = main_window(app) {
        let _ = window.emit(event, ());
    }
}

fn open_quit_confirmation(app: &AppHandle) {
    QUIT_CONFIRMATION_ACTIVE.store(true, Ordering::Release);
    emit_main_window(app, EVENT_QUIT_CONFIRMATION_OPEN);
}

fn close_quit_confirmation_state(app: &AppHandle) {
    if !QUIT_CONFIRMATION_ACTIVE.swap(false, Ordering::AcqRel) {
        return;
    }
    emit_main_window(app, EVENT_QUIT_CONFIRMATION_CLOSE);
}

fn quit_app(app: &AppHandle) {
    QUIT_CONFIRMATION_ACTIVE.store(false, Ordering::Release);
    app.exit(0);
}

/// Setup menu event handlers
pub fn setup_menu_events(app: &AppHandle) {
    let app_handle = app.clone();

    app.on_menu_event(move |app, event| {
        let event_id = event.id().0.as_str();

        match event_id {
            "app_quit" => {
                open_quit_confirmation(app);
            }
            "file_new_session" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-new-session", ());
                }
            }
            "file_open_folder" => {
                // Emit event to frontend to open folder dialog
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-file-open-folder", ());
                }
            }
            "file_add_folder_to_workspace" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-add-folder-to-workspace", ());
                }
            }
            "file_save_workspace_as" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-save-workspace-as", ());
                }
            }
            "file_close_window" | "window_close_window" => {
                // Close the focused window
                let windows = app.webview_windows();
                let focused = windows
                    .values()
                    .find(|window| window.is_focused().unwrap_or(false));
                if let Some(window) = focused {
                    let _ = window.close();
                }
            }
            "view_zoom_in" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-zoom-in", ());
                }
            }
            "view_zoom_out" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-zoom-out", ());
                }
            }
            "view_zoom_reset" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-zoom-reset", ());
                }
            }
            "view_command_palette" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-toggle-spotlight", ());
                }
            }
            "view_go_to_file" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-file-palette", ());
                }
            }
            "view_switch_workspace" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-workspace-selector", ());
                }
            }
            "view_switch_branch" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-branch-selector", ());
                }
            }
            "view_switch_location" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-location-selector", ());
                }
            }
            "view_select_model" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-model-selector", ());
                }
            }
            "view_open_settings" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-open-settings", ());
                }
            }
            "edit_select_all" => {
                // Emit to frontend so JS can dispatch selectAll to the focused element.
                // This replaces the built-in .select_all() which sends a native macOS
                // selector that XTerm.js canvas ignores.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-select-all", ());
                }
            }
            "window_maximize_work_station" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("menu-maximize-work-station", ());
                }
            }
            // NOTE: Toggle Sidebar (Cmd+B) and Toggle Terminal (Cmd+`) are NOT in the native menu.
            // They are context-dependent frontend actions handled by the webview's keydown handler.
            "help_documentation" => {
                let _ = open::that("https://github.com/YORG-AI/ORGII/wiki");
            }
            "help_report_issue" => {
                let _ = open::that("https://github.com/YORG-AI/ORGII/issues");
            }
            MENU_ID_RESTART_SETUP => {
                println!("[AppMenu] Restart Setup Guide requested");
                if let Err(error) = app.emit(EVENT_REOPEN_SETUP, ()) {
                    eprintln!(
                        "[AppMenu] Failed to broadcast {}: {}",
                        EVENT_REOPEN_SETUP, error
                    );
                }
            }
            "recent_clear" => {
                clear_recent_menu(&app_handle);
                let _ = rebuild_menu(&app_handle);
            }
            id if id.starts_with("recent_") && id != "recent_none" && id != "recent_clear" => {
                // Handle recent item click
                if let Ok(index) = id.strip_prefix("recent_").unwrap_or("").parse::<usize>() {
                    let recent_paths = get_recent_paths();
                    if let Some(path) = recent_paths.get(index) {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.emit("menu-open-recent", path.clone());
                        }
                    }
                }
            }
            _ => {}
        }
    });
}

/// Rebuild the menu (call after adding/removing recent items)
#[cfg(windows)]
pub fn rebuild_menu(_app: &AppHandle) -> Result<(), tauri::Error> {
    // Windows owns its single-row frameless chrome in `WindowsTopBar`.
    // Attaching a native application menu adds a second File/Edit/View row
    // beneath the web header and forces conflicting non-client chrome.
    Ok(())
}

/// Rebuild the menu (call after adding/removing recent items)
#[cfg(not(windows))]
pub fn rebuild_menu(app: &AppHandle) -> Result<(), tauri::Error> {
    let menu = create_app_menu(app)?;
    app.set_menu(menu)?;
    Ok(())
}

// ============================================
// Tauri Commands
// ============================================

/// Add a path to the recent menu, persist to disk, and rebuild the menu
#[tauri::command]
pub fn menu_add_recent(app: AppHandle, path: String) -> Result<(), String> {
    add_to_recent_menu(&app, path);
    rebuild_menu(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn confirm_quit_app(app: AppHandle) {
    quit_app(&app);
}

#[tauri::command]
pub fn cancel_quit_confirmation(app: AppHandle) {
    close_quit_confirmation_state(&app);
}
