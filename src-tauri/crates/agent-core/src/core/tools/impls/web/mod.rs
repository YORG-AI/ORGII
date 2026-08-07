//! Web tool implementations.
//!
//! One file (or subfolder) per tool — file/folder name matches the tool name.
//!
//! - [`browser_cli_tool`]         — shared raw browser CLI tool implementation
//! - [`control_browser_with_agent_browser`] — Agent Browser CLI raw command tool
//! - [`control_browser_with_playwright`] — Playwright CLI raw command tool
//! - [`control_internal_browser`] — `control_internal_browser` (webview-based internal browser)
//! - [`control_orgii`]             — `control_orgii` GUI control + shared `ActionBridge` infra
//! - [`web_fetch`]                — `web_fetch` tool (HTTP GET + HTML→text)
//! - [`web_search`]               — `web_search` tool (Brave Search API)

pub mod browser_cli_tool;
pub mod control_browser_with_agent_browser;
pub mod control_browser_with_playwright;
pub mod control_internal_browser;
pub mod control_orgii;
pub mod reply_session_comment;
pub mod spotlight;
pub mod web_fetch;
pub mod web_search;
