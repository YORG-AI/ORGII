//! Browser and WebView Management
//!
//! Provides comprehensive webview functionality for the application:
//!
//! ## Modules
//!
//! - [`windows`]: Standalone browser windows for external sites
//! - [`inline`]: Embedded webviews within the main app window
//! - [`logging`]: Console and network log capture from webviews
//! - [`cookies`]: Native cookie access (including HttpOnly)
//! - [`global_tokens`]: Stateless CSS-variable scanning for browser design tools
//! - [`scripts`]: JavaScript injection scripts for anti-bot detection, etc.
//! - [`internal_browser_commands`]: DOM automation Tauri commands for inline webviews
//! - [`types`]: Shared type definitions
//!
//! ## Browser Windows vs Inline Webviews
//!
//! | Feature | Browser Windows | Inline Webviews |
//! |---------|-----------------|-----------------|
//! | Window | Standalone | Embedded in main window |
//! | Decorations | Yes (title bar) | No |
//! | Position | User-controlled | App-controlled (x, y, w, h) |
//! | Use case | External browsing | Embedded web content |
//!
//! ## Platform-Specific Features (macOS)
//!
//! On macOS, this module provides:
//! - Native cookie access via WKHTTPCookieStore (includes HttpOnly cookies)
//! - Fallback to NSHTTPCookieStorage for system-wide cookies
//! - WKWebView JavaScript evaluation for log retrieval
//!
//! ## Events Emitted
//!
//! - `browser-navigation`: When a browser window navigates to a new URL
//! - `webview-new-window-request`: When an inline webview tries to open a popup

pub mod automation;
pub mod capture;
pub mod cookies;
pub mod dom_editor;
pub mod global_tokens;
pub mod inline;
pub mod internal_browser_commands;
pub mod internal_browser_state;
pub mod layering;
pub mod logging;
pub mod screenshot_store;
pub mod scripts;
pub mod types;
pub mod windows;

// Re-export all public items for convenient access
pub use capture::*;
pub use cookies::*;
pub use dom_editor::*;
pub use global_tokens::*;
pub use inline::*;
pub use internal_browser_commands::*;
pub use internal_browser_state::*;
pub use layering::*;
pub use logging::*;
pub use screenshot_store::*;
pub use scripts::*;
pub use types::*;
pub use windows::*;
