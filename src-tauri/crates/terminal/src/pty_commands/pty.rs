//! PTY (Pseudo-Terminal) Module
//!
//! Provides integrated terminal functionality using native PTY on each platform.
//! Sessions are managed server-side and stream output to the frontend via Tauri events.
//!
//! # Architecture
//!
//! ```text
//! Frontend (React)                    Backend (Rust)
//! ┌─────────────────┐                ┌─────────────────┐
//! │  Terminal UI    │◄──events─────-─│   PtySession    │
//! │  (xterm.js)     │                │  ┌───────────┐  │
//! │                 │───invoke──────►│  │ PTY Master│  │
//! │                 │  write_pty     │  └─────┬─────┘  │
//! └─────────────────┘                │        │        │
//!                                    │  ┌─────▼─────┐  │
//!                                    │  │   Shell   │  │
//!                                    │  │ (zsh/bash)│  │
//!                                    │  └───────────┘  │
//!                                    └─────────────────┘
//! ```
//!
//! # Events
//!
//! - `pty-output-{session_id}`: Emitted when the PTY produces output
//!   (JSON: `{ b64, byte_count, seq }`)
//! - `pty-exit-{session_id}`: Emitted when the PTY session terminates
//!
//! # Session Lifecycle
//!
//! 1. Frontend calls `create_pty` with session ID, dimensions, and optional shell/cwd
//! 2. Backend spawns PTY with shell process and starts output reader task
//! 3. Frontend sends keystrokes via `write_pty`
//! 4. Backend streams output back via `pty-output-{session_id}` events
//! 5. Frontend calls `close_pty` or session ends when shell exits
//!
//! # Platform Support
//!
//! - **macOS/Linux**: Uses `zsh` as default shell with `-il` flags (interactive login)
//! - **Windows**: Uses `powershell.exe` as default shell

mod exit_sweep;
mod inspection_commands;
mod lifecycle_commands;
mod process_inspect;
mod session;
mod state;
mod types;

#[cfg(unix)]
pub(crate) use exit_sweep::register_session_leader;
pub use inspection_commands::*;
pub use lifecycle_commands::*;
pub use session::PtySession;
pub use state::PtyState;
pub use types::{
    AttachPtyStream, CreatePtyRequest, ForegroundProcessInfo, PtyInfo, PtyMemoryInfo,
    PtyOutputSnapshot, ResizePtyRequest,
};
