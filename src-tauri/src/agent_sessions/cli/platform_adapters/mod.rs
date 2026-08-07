//! Per-runner credential capture, usage tracking, and auth support.
//!
//! Each sub-module corresponds to a specific CLI agent runner (Cursor, Kiro, etc.)
//! and contains platform-specific lifecycle code: webview credential flows,
//! SSO device flows, usage API clients, and proxy auth DB setup.

pub mod claude_code;
pub mod codex;
pub mod cursor;
pub mod kiro;
pub mod webview_session;
