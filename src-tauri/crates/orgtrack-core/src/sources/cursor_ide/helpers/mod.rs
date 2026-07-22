//! Pure utility functions and the bubble→ActivityChunk pipeline.
//!
//! All items are `pub(super)` — internal to `cursor_db_history` and its
//! sibling submodules only.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

use core_types::activity::ActivityChunk;

use super::history::{CursorIdeSessionRow, CURSORIDE_SESSION_PREFIX, CURSOR_IDE_CATEGORY};
use super::io::load_content_blob;
use super::models::{
    CursorComposerContext, CursorWorkspaceMetadata, OrderedBubble, RawBubble, RawComposerHeader,
    RawCursorSubagentInfo, RawToolFormerData,
};
// Sibling module aliases so submodule code moved out of this file keeps
// resolving its original `super::db::…` / `super::models::…` paths (whose
// `super` was `cursor_ide`) against this `helpers` module instead.
use super::db;
use super::models;

// ============================================================================
// Constants
// ============================================================================

const CURSOR_BUBBLE_TYPE_USER: i64 = 1;
const CURSOR_BUBBLE_TYPE_ASSISTANT: i64 = 2;

mod chunks;
mod placeholders;
mod session;
mod text;

pub(in crate::sources::cursor_ide) use chunks::*;
pub(in crate::sources::cursor_ide) use placeholders::*;
pub(in crate::sources::cursor_ide) use session::*;
pub(in crate::sources::cursor_ide) use text::*;
