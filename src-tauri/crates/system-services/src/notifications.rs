//! System notifications and dock badge management
//!
//! Handles system notifications and macOS dock badge

use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

#[cfg(target_os = "macos")]
use objc2::msg_send;
#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};
#[cfg(target_os = "macos")]
use objc2_foundation::NSString;

/// Send a system notification
#[tauri::command]
pub fn send_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("Failed to send notification: {}", e))?;
    Ok(())
}

/// Check notification permission
#[tauri::command]
pub fn check_notification_permission(app: AppHandle) -> Result<String, String> {
    let permission = app
        .notification()
        .permission_state()
        .map_err(|e| format!("Failed to check permission: {}", e))?;

    match permission {
        PermissionState::Granted => Ok("granted".to_string()),
        PermissionState::Denied => Ok("denied".to_string()),
        _ => Ok("unknown".to_string()),
    }
}

/// Request notification permission
#[tauri::command]
pub fn request_notification_permission(app: AppHandle) -> Result<String, String> {
    let permission = app
        .notification()
        .request_permission()
        .map_err(|e| format!("Failed to request permission: {}", e))?;

    match permission {
        PermissionState::Granted => Ok("granted".to_string()),
        PermissionState::Denied => Ok("denied".to_string()),
        _ => Ok("unknown".to_string()),
    }
}

/// Set the dock badge on macOS
/// Pass a number to show as badge, or None/0 to clear the badge
#[tauri::command]
pub fn set_dock_badge(count: Option<u32>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let ns_application = AnyClass::get(c"NSApplication").expect("NSApplication");
            let app: *mut AnyObject = msg_send![ns_application, sharedApplication];
            let dock_tile: *mut AnyObject = msg_send![app, dockTile];

            match count {
                Some(n) if n > 0 => {
                    let badge_string = NSString::from_str(&n.to_string());
                    let _: () = msg_send![dock_tile, setBadgeLabel: &*badge_string];
                }
                _ => {
                    let _: () = msg_send![dock_tile, setBadgeLabel: std::ptr::null::<AnyObject>()];
                }
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = count;
        Ok(())
    }
}
