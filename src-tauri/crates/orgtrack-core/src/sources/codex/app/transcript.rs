//! Transcript loading and tool-call chunk assembly.

mod cache;
mod catalog;
mod collector;
mod messages;
mod parser;
mod reader;
mod tool_calls;

const CODEX_PROVIDER_SLUG: &str = "codex";

pub use reader::{
    load_codex_app_from_path, load_codex_app_initial_window_from_path,
    load_codex_app_turn_from_path, CodexAppInitialWindow, CodexAppTurnWindow,
};

pub(super) use messages::user_message_text_from_line;
#[allow(unused_imports)]
pub(crate) use messages::{legacy_user_message_text_from_payload, strip_ignored_embedded_images};
pub(crate) use reader::{load_codex_app_cloud_turn_from_path, load_codex_app_turn_ids_from_path};
#[allow(unused_imports)]
pub(crate) use tool_calls::{output_parts_for_tool_calls, pending_custom_tool_calls_from_payload};

#[cfg(test)]
mod tests;
