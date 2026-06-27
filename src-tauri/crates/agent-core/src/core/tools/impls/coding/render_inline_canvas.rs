//! render_inline_canvas tool — display interactive UI directly in the chat panel.
//!
//! Available to both SDE Agent and OS Agent. Lets the LLM render an
//! interactive data visualisation, a live preview, or a streaming UI
//! element (A2UI) inline in the chat without requiring a separate canvas app.
//!
//! ## Modes
//! - `"html"` — self-contained HTML/SVG/CSS string rendered in a sandboxed
//!   iframe. The agent should inline all styles and scripts.
//! - `"url"` — a URL that will be loaded inside an embedded iframe. Only
//!   HTTPS URLs or relative paths are accepted by the frontend sandbox.
//! - `"a2ui"` — a streaming JSONL sequence of A2UI element descriptors.
//!   Supported types: heading, text, code, image, button, divider, list,
//!   table, chart, form. Each JSONL line is streamed incrementally to the
//!   card as it arrives.
//!
//! ## Return value
//! The tool echoes back the accepted payload as a JSON confirmation so the LLM
//! can verify the arguments were accepted. The frontend picks up the canvas
//! event through the `canvas-inline-event` window event pipeline — not via the
//! tool result text.

use async_trait::async_trait;
use serde_json::Value;

use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

pub struct RenderInlineCanvasTool;

impl RenderInlineCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RenderInlineCanvasTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for RenderInlineCanvasTool {
    fn name(&self) -> &str {
        tool_names::RENDER_INLINE_CANVAS
    }

    fn description(&self) -> &str {
        "Render interactive UI directly inside the chat panel as a sandboxed inline card.\n\
         Use this to present data visualisations, live previews, or structured output\n\
         without leaving the conversation.\n\n\
         Modes:\n\
         - \"html\": Render a self-contained HTML/SVG/CSS snippet. Inline all styles and\n\
           scripts — no external CDN links (they are blocked by the sandbox).\n\
         - \"url\": Embed an HTTPS URL in an iframe. Suitable for live dashboards or\n\
           documentation pages that are safe to embed.\n\
         - \"a2ui\": Stream a sequence of typed UI elements as JSONL lines. Each line is\n\
           a JSON object with a \"type\" field. Supported types:\n\
           heading | text | code | image | button | divider | list | table | chart | form\n\
         - \"react\": Render a JavaScript React App component in an isolated iframe sandbox.\n\
           This MVP expects precompiled JavaScript / React.createElement code; JSX is not transformed.\n\
           Runtime errors are displayed inside the preview.\n\n\
         A2UI element reference:\n\
         - heading:  {\"type\":\"heading\",\"content\":\"Title\"}\n\
         - text:     {\"type\":\"text\",\"content\":\"Paragraph text\"}\n\
         - code:     {\"type\":\"code\",\"content\":\"print('hello')\"}\n\
         - image:    {\"type\":\"image\",\"content\":\"https://…/image.png\"}\n\
         - divider:  {\"type\":\"divider\"}\n\
         - list:     {\"type\":\"list\",\"items\":[\"Item 1\",\"Item 2\"]}\n\
         - button:   {\"type\":\"button\",\"content\":\"Run Analysis\",\"actionId\":\"run_analysis\"}\n\
           actionId triggers a bidirectional callback — the frontend fires onAction(actionId).\n\
         - table:    {\"type\":\"table\",\"headers\":[\"Col1\",\"Col2\",\"Col3\"],\n\
                      \"rows\":[[\"A\",\"B\",\"C\"],[\"D\",\"E\",\"F\"]]}\n\
           Data table with a styled header row and alternating row colours.\n\
         - chart:    {\"type\":\"chart\",\"chartType\":\"bar\",\"title\":\"Q1 Sales\",\n\
                      \"data\":{\"labels\":[\"Jan\",\"Feb\",\"Mar\"],\n\
                               \"datasets\":[{\"label\":\"Revenue\",\"values\":[72,88,60]}]}}\n\
           Bar or line chart rendered with recharts. chartType is \"bar\" or \"line\".\n\
         - form:     {\"type\":\"form\",\n\
                      \"fields\":[{\"name\":\"query\",\"label\":\"Search\",\"inputType\":\"text\"}],\n\
                      \"submitLabel\":\"Submit\",\"actionId\":\"search\"}\n\
           Interactive form. inputType: \"text\" | \"select\" | \"checkbox\".\n\
           On submit, onAction(actionId, fieldValues) is fired.\n\n\
         Guidelines:\n\
         - Prefer \"a2ui\" for structured reports, tables, and charts — it streams incrementally.\n\
         - Prefer \"html\" only for bespoke layouts that none of the a2ui types can express.\n\
         - Keep HTML payloads under 64 KB for smooth rendering.\n\
         - Always set a descriptive \"title\" — it appears in the card header."
    }

    fn category(&self) -> &str {
        crate::tools::categories::GENERAL
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn parameters(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "required": ["mode"],
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["html", "url", "a2ui", "react"],
                    "description": "Rendering mode: \"html\" for inline HTML, \"url\" for URL embed, \"a2ui\" for streamed typed elements, \"react\" for a React App component sandbox."
                },
                "content": {
                    "type": "string",
                    "description": "The HTML/SVG/CSS string for \"html\" mode, JavaScript React App component source for \"react\" mode, or the JSONL payload for \"a2ui\" mode. Not used in \"url\" mode."
                },
                "url": {
                    "type": "string",
                    "description": "The HTTPS URL to embed. Required for \"url\" mode; ignored for other modes."
                },
                "title": {
                    "type": "string",
                    "description": "Optional human-readable title shown in the card header."
                },
                "streaming": {
                    "type": "boolean",
                    "description": "Set to true when content will be appended in multiple calls (a2ui streaming). Defaults to false."
                }
            },
            "additionalProperties": false
        })
    }

    async fn execute_text(
        &self,
        params: Value,
        _ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        let mode = params
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidParams("missing required field: mode".into()))?;

        match mode {
            "html" | "a2ui" | "react" => {
                if params.get("content").and_then(Value::as_str).is_none() {
                    return Err(ToolError::InvalidParams(
                        "field \"content\" is required for html, a2ui, and react modes".into(),
                    ));
                }
            }
            "url" => {
                let url = params.get("url").and_then(Value::as_str).ok_or_else(|| {
                    ToolError::InvalidParams("field \"url\" is required for url mode".into())
                })?;
                if !url.starts_with("https://") && !url.starts_with('/') {
                    return Err(ToolError::InvalidParams(
                        "url mode requires an HTTPS URL or a relative path".into(),
                    ));
                }
            }
            other => {
                return Err(ToolError::InvalidParams(format!(
                    "unknown mode \"{other}\"; expected one of: html, url, a2ui, react"
                )));
            }
        }

        // Return a concise confirmation — the actual content is not echoed back
        // to the LLM because it can be many KB of HTML/JSONL that would bloat
        // the context window. The frontend reads the canvas payload from the
        // `agent:tool_call` args (dispatched before this result arrives), so
        // the full content is already available without appearing in the LLM
        // tool_result message.
        let title = params
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("(no title)");

        let content_len = params
            .get("content")
            .and_then(Value::as_str)
            .map(|s| s.len())
            .unwrap_or(0);

        Ok(match mode {
            "html" | "a2ui" | "react" => format!(
                "render_inline_canvas: rendered {mode} content ({content_len} bytes), title=\"{title}\""
            ),
            "url" => {
                let url = params.get("url").and_then(Value::as_str).unwrap_or("");
                format!("render_inline_canvas: embedded url=\"{url}\", title=\"{title}\"")
            }
            _ => format!("render_inline_canvas: accepted mode={mode}, title=\"{title}\""),
        })
    }
}
