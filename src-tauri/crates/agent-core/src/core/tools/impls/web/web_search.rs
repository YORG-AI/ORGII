//! `web_search` tool — Brave Search API.

use async_trait::async_trait;
use reqwest::Client;
use serde_json::Value;

use crate::tools::categories as tool_categories;
use crate::tools::names as tool_names;
use crate::tools::traits::{optional_int, required_string, Tool, ToolError};

pub struct WebSearchTool {
    api_key: Option<String>,
    client: Client,
}

impl WebSearchTool {
    pub fn new(api_key: Option<String>) -> Self {
        Self {
            api_key,
            client: Client::new(),
        }
    }
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        tool_names::WEB_SEARCH
    }

    fn category(&self) -> &str {
        tool_categories::WEB
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn is_ready(&self) -> bool {
        self.api_key.is_some()
    }

    fn not_ready_reason(&self) -> Option<&str> {
        if self.api_key.is_none() {
            Some("Brave Search API key not configured (tools.webSearch.apiKey)")
        } else {
            None
        }
    }

    fn description(&self) -> &str {
        "Search the web for information. Returns titles, URLs, and descriptions of results."
    }

    fn llm_description(&self) -> Option<String> {
        let month_year = chrono::Local::now().format("%B %Y").to_string();
        Some(format!(
            "Search the web for real-time information. Returns titles, URLs, and descriptions.\n\n\
             IMPORTANT: The current month is {month_year}. You MUST use this year when searching \
             for recent information, documentation, or current events."
        ))
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search query"
                },
                "count": {
                    "type": "integer",
                    "description": "Number of results (1-10, default 5)",
                    "minimum": 1,
                    "maximum": 10
                }
            },
            "required": ["query"]
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        ctx.require_tool_authority(self.name())?;
        let query = required_string(&params, "query")?;
        let count = optional_int(&params, "count").unwrap_or(5).clamp(1, 10);

        let Some(ref api_key) = self.api_key else {
            return Err(ToolError::ExecutionFailed(
                "Brave Search API key not configured. Set tools.webSearch.apiKey in config."
                    .to_string(),
            ));
        };

        let response = self
            .client
            .get("https://api.search.brave.com/res/v1/web/search")
            .header("X-Subscription-Token", api_key)
            .header("Accept", "application/json")
            .query(&[("q", &query), ("count", &count.to_string())])
            .send()
            .await
            .map_err(|err| ToolError::ExecutionFailed(format!("Search request failed: {}", err)))?;

        let status = response.status();
        if !status.is_success() {
            return Err(ToolError::ExecutionFailed(format!(
                "Search API returned HTTP {}",
                status
            )));
        }

        let body: Value = response.json().await.map_err(|err| {
            ToolError::ExecutionFailed(format!("Failed to parse search results: {}", err))
        })?;

        let mut results = Vec::new();
        if let Some(web_results) = body
            .get("web")
            .and_then(|w| w.get("results"))
            .and_then(|r| r.as_array())
        {
            for (idx, item) in web_results.iter().enumerate() {
                let title = item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(no title)");
                let url = item.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let desc = item
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                results.push(format!("{}. {}\n   {}\n   {}", idx + 1, title, url, desc));
            }
        }

        if results.is_empty() {
            Ok("No results found.".to_string())
        } else {
            Ok(results.join("\n\n"))
        }
    }
}
