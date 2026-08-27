use async_trait::async_trait;
use serde_json::{json, Value};

use crate::tools::categories as tool_categories;
use crate::tools::traits::{required_string, Tool, ToolError};
use shared_state::{
    run_browser_cli_command, split_browser_cli_command, AgentBrowserConfig,
    BrowserAutomationProvider,
};

#[derive(Debug, Clone)]
pub struct BrowserCliTool {
    name: &'static str,
    display_name: &'static str,
    description: &'static str,
    provider: BrowserAutomationProvider,
    config: AgentBrowserConfig,
}

impl BrowserCliTool {
    pub fn new(
        name: &'static str,
        display_name: &'static str,
        description: &'static str,
        provider: BrowserAutomationProvider,
        config: AgentBrowserConfig,
    ) -> Self {
        Self {
            name,
            display_name,
            description,
            provider,
            config,
        }
    }
}

#[async_trait]
impl Tool for BrowserCliTool {
    fn name(&self) -> &str {
        self.name
    }

    fn category(&self) -> &str {
        tool_categories::WEB
    }

    fn description(&self) -> &str {
        self.description
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Raw CLI subcommand and arguments to pass to the selected browser automation provider, for example: open https://example.com, snapshot, screenshot /tmp/page.png, close. Do not include the executable name or session flags."
                }
            },
            "required": ["command"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let command = required_string(&params, "command")?;
        let args = split_browser_cli_command(&command)
            .map_err(|err| ToolError::InvalidParams(err.to_string()))?;
        let output = run_browser_cli_command(
            self.provider,
            self.config.agent_browser_cli_path.as_deref(),
            self.config.playwright_cli_path.as_deref(),
            &args,
        )
        .await
        .map_err(ToolError::ExecutionFailed)?;

        Ok(output.as_tool_text(self.display_name))
    }
}
