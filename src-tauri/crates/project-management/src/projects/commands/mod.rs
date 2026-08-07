//! Tauri command façade for the centralized project store.
//!
//! Every public function here is a `#[tauri::command]` named
//! `project_<verb>_<subject>`. The body is intentionally a thin shell:
//! decode the args, hand off to the matching `super::io` function via
//! `tokio::task::spawn_blocking`, and surface any join error as a
//! `String` so the frontend's `invoke()` rejection path stays uniform.
//!
//! Why `spawn_blocking`: rusqlite is sync. Calling it directly on a
//! Tauri command (which runs on the async runtime) would block the
//! reactor — fine for a single user, fatal once we have a sync worker
//! and an interactive UI competing for the runtime. Off-loading every
//! DB call to the blocking pool keeps the runtime responsive.
//!
//! Why not return rich error types: Tauri's `invoke()` boundary
//! serializes errors via `serde::Serialize`. Sticking to `String` means
//! every `Result<_, String>` from the IO layer round-trips unchanged
//! and the frontend always parses a single shape.

mod assets;
mod collab_leave;
mod collab_sync;
mod config;
mod init;
mod linear_projects;
mod orgs;
mod projects;
mod routines;
pub mod sync;
mod work_items;

// Glob re-export so the Tauri-generated `__cmd__*` shims travel with
// the public functions; `handler_list.inc` references the function
// path and the macro internals must resolve at the same path.
pub use assets::*;
pub use collab_leave::*;
pub use collab_sync::*;
pub use config::*;
pub use init::*;
pub use linear_projects::*;
pub use orgs::*;
pub use projects::*;
pub use routines::*;
pub use sync::*;
pub use work_items::*;
