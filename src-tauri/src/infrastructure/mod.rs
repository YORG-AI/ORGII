//! Infrastructure Domain
//!
//! Cross-cutting in-tree infrastructure that is too small or too tightly
//! coupled to `app::run()` to live in its own workspace crate. Hot leaf
//! pieces (perf, transport, file_ops, window, platform commands) have
//! all been hoisted to dedicated workspace crates and are referenced
//! through their bare crate names — no `infrastructure::*` re-export
//! shims.

// Frontend log persistence (IPC → ~/.orgii/logs/frontend.log)
pub mod frontend_log;

// macOS main-run-loop wake nudge for backend → frontend notification delivery
pub mod main_runloop;

// Disk-usage and storage-management Tauri commands. Path helpers
// themselves live in the `app_paths` workspace crate; this module just
// composes them into the Settings → Disk Usage report.
pub mod storage_commands;

// Spreadsheet CSV/TSV page reading and patch-based saving for large files.
pub mod spreadsheet_csv;

// Spreadsheet XLSX page reading and patch-based saving for large files.
pub mod spreadsheet_xlsx;

// Folder archive creation (ZIP for cloud upload)
pub mod archive;

// Centralized code search index management
pub mod index_manager;

// Shared JSON-RPC 2.0 protocol types
pub mod jsonrpc;

// Deferred disk cleanup orchestrator (file-history TTL, log rotation, cap enforcement)
pub mod housekeeping;
