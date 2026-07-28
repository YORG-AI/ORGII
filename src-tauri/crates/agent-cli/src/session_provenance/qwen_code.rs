//! Qwen Code managed hooks. Qwen consumes the Claude-Code-style nested JSON
//! `hooks.PostToolUse` schema, so its install runs through the shared
//! `update_nested_platform` helper in the dispatcher; only the file-tool
//! matcher is Qwen-specific.

// Qwen Code is a Gemini-family CLI: its file tools are snake_case
// (`write_file`, `replace`, `read_file`, …). Scope the managed PostToolUse
// hook to those so it does not spawn a capture process on every shell call.
pub(super) const QWEN_CODE_POST_TOOL_USE_MATCHER: &str =
    "write_file|replace|read_file|read_many_files|glob|search_file_content";
