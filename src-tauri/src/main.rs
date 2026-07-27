//! ORGII Desktop Application
//!
//! Main entry point for the Tauri application.

// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "dhat-heap")]
#[global_allocator]
static DHAT_ALLOCATOR: app_lib::dhat_profiling::DhatAllocator =
    app_lib::dhat_profiling::DhatAllocator::new();

fn main() {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--session-provenance-hook") {
        if let Some(source) = args.next() {
            // Hooks are observational: capture failure must never fail or delay
            // the agent tool invocation that triggered this process.
            let _ = app_lib::orgtrack::session_provenance::capture_hook_stdin(&source);
        }
        return;
    }
    app_lib::run();
}
