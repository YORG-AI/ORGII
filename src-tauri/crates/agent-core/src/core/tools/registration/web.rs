//! Web tool registration: search, fetch, browser automation, GUI control.

use std::collections::HashSet;

use crate::tools::impls::web::control_browser_with_agent_browser;
use crate::tools::impls::web::control_browser_with_playwright;
use crate::tools::impls::web::control_internal_browser::InternalBrowserTool;
use crate::tools::impls::web::control_orgii::OrgiiControlTool;
use crate::tools::impls::web::reply_session_comment::ReplySessionCommentTool;
use crate::tools::impls::web::spotlight::SpotlightTool;
use crate::tools::impls::web::web_fetch::WebFetchTool;
use crate::tools::impls::web::web_search::WebSearchTool;
use crate::tools::registry::ToolRegistry;
use shared_state::BrowserAutomationProvider;

use super::{register_if_enabled, ToolDeps};

/// Register all web-category tools that `deps` can support.
///
/// Covers: `web_search`, `web_fetch`, exactly one selected external browser CLI
/// tool, and `control_internal_browser`.
pub async fn register(registry: &mut ToolRegistry, deps: &ToolDeps, disabled: &HashSet<String>) {
    if let Some(bridge) = deps.action_bridge.clone() {
        register_if_enabled(
            registry,
            Box::new(OrgiiControlTool::new(bridge.clone())),
            disabled,
        );
        register_if_enabled(
            registry,
            Box::new(SpotlightTool::new(bridge.clone())),
            disabled,
        );
        register_if_enabled(
            registry,
            Box::new(ReplySessionCommentTool::new(bridge)),
            disabled,
        );
    }

    register_if_enabled(
        registry,
        Box::new(WebSearchTool::new(deps.web_search_api_key.clone())),
        disabled,
    );

    register_if_enabled(registry, Box::new(WebFetchTool::new()), disabled);

    if let Some(config) = deps.agent_browser_config.clone() {
        match config.provider {
            BrowserAutomationProvider::AgentBrowser => register_if_enabled(
                registry,
                Box::new(control_browser_with_agent_browser::new(config)),
                disabled,
            ),
            BrowserAutomationProvider::Playwright => register_if_enabled(
                registry,
                Box::new(control_browser_with_playwright::new(config)),
                disabled,
            ),
        }
    }

    register_if_enabled(
        registry,
        Box::new(InternalBrowserTool::new(deps.app_handle.clone())),
        disabled,
    );
}
