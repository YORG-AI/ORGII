//! render_inline_canvas tool — display interactive UI directly in the chat panel.
//!
//! Available to both SDE Agent and OS Agent. Lets the LLM render an
//! interactive data visualisation, a live preview, or a streaming UI
//! element (A2UI) inline in the chat without requiring a separate canvas app.
//!
//! ## Modes
//! - `"html"` — self-contained HTML/SVG/CSS string sanitized and rendered in
//!   Shadow DOM. Styles are preserved; scripts and event handlers are removed.
//! - `"url"` — an HTTPS URL or relative path presented as an external-open
//!   action rather than embedded in chat.
//! - `"a2ui"` — a streaming JSONL sequence of A2UI element descriptors.
//!   Supported types: heading, text, code, image, button, divider, list,
//!   table, chart, form. Each JSONL line is streamed incrementally to the
//!   card as it arrives.
//!
//! ## Return value
//! The tool returns a concise acceptance acknowledgment. It deliberately does
//! not claim visual success because the tool execution path cannot inspect the
//! rendered card. The frontend picks up the canvas event through the
//! `canvas-inline-event` window event pipeline — not via the tool result text.

use async_trait::async_trait;
use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;
use std::collections::HashSet;

use crate::tools::names as tool_names;
use crate::tools::traits::{Tool, ToolError};

pub struct RenderInlineCanvasTool;
pub struct ReviseInlineCanvasTool;

const MAX_CANVAS_REVISION_EDITS: usize = 16;
const MAX_CANVAS_REVISION_EDIT_CHARS: usize = 32_768;
const MAX_CANVAS_REVISION_AGENT_STEPS: usize = 6;
const MAX_CANVAS_REVISION_AGENT_STEP_CHARS: usize = 80;
const MAX_CANVAS_REVISION_CHAIN_DEPTH: usize = 32;

fn format_canvas_acceptance(
    tool_name: &str,
    mode: &str,
    content_len: usize,
    title: &str,
    url: &str,
) -> String {
    match mode {
        "html" | "a2ui" | "react" => format!(
            "{tool_name}: accepted {mode} content ({content_len} bytes), title=\"{title}\"; visual output not verified"
        ),
        "url" => format!(
            "{tool_name}: accepted url=\"{url}\", title=\"{title}\"; visual output not verified"
        ),
        _ => format!("{tool_name}: accepted mode={mode}, title=\"{title}\""),
    }
}

fn canvas_parameters(revision: bool) -> Value {
    let mut schema = serde_json::json!({
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
                "description": "The complete HTML/SVG/CSS string for \"html\" mode, JavaScript React App component source for \"react\" mode, or JSONL payload for \"a2ui\" mode. Not used in \"url\" mode."
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
    });

    if revision {
        schema["required"] = serde_json::json!(["target_event_id", "mode", "agent_steps"]);
        schema["properties"]
            .as_object_mut()
            .expect("canvas properties are an object")
            .insert(
                "agent_steps".to_string(),
                serde_json::json!({
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_CANVAS_REVISION_AGENT_STEPS,
                    "description": "Ordered short, factual, user-visible labels describing the concrete operations for this revision. Generate these labels for the current request in the user's language; do not use a fixed template and do not include private reasoning. Emit agent_steps before edits or content so progress can appear while the remaining arguments stream.",
                    "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": MAX_CANVAS_REVISION_AGENT_STEP_CHARS
                    }
                }),
            );
        schema["properties"]
            .as_object_mut()
            .expect("canvas properties are an object")
            .insert(
                "target_event_id".to_string(),
                serde_json::json!({
                    "type": "string",
                    "minLength": 1,
                    "description": "Exact event id of the existing Canvas version to replace. It must belong to the current session and identify a render_inline_canvas or revise_inline_canvas event."
                }),
            );
        schema["properties"]
            .as_object_mut()
            .expect("canvas properties are an object")
            .insert(
                "edits".to_string(),
                serde_json::json!({
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_CANVAS_REVISION_EDITS,
                    "description": "Preferred for localized copy, value, or style changes. Apply these exact literal replacements to the current materialized Canvas source instead of returning the complete content. Each edit must match exactly once unless all=true.",
                    "items": {
                        "type": "object",
                        "required": ["find", "replace"],
                        "properties": {
                            "find": {
                                "type": "string",
                                "minLength": 1,
                                "maxLength": MAX_CANVAS_REVISION_EDIT_CHARS,
                                "description": "Exact literal source text to find. Include enough surrounding text to make the match unique."
                            },
                            "replace": {
                                "type": "string",
                                "maxLength": MAX_CANVAS_REVISION_EDIT_CHARS,
                                "description": "Literal replacement source text."
                            },
                            "all": {
                                "type": "boolean",
                                "description": "Set true only when every occurrence should change. Defaults to false, which requires exactly one match."
                            }
                        },
                        "additionalProperties": false
                    }
                }),
            );
        schema["properties"]["content"]["description"] = serde_json::json!(
            "Complete replacement source for structural revisions. Omit this field when using edits for a localized change."
        );
    }

    schema
}

fn canvas_revision_edits(params: &Value) -> Option<&Vec<Value>> {
    params.get("edits").and_then(Value::as_array)
}

fn validate_canvas_revision_edits(edits: &[Value]) -> Result<(), ToolError> {
    if edits.is_empty() || edits.len() > MAX_CANVAS_REVISION_EDITS {
        return Err(ToolError::InvalidParams(format!(
            "field \"edits\" must contain 1 to {MAX_CANVAS_REVISION_EDITS} operations"
        )));
    }

    for (index, edit) in edits.iter().enumerate() {
        let find = edit.get("find").and_then(Value::as_str).ok_or_else(|| {
            ToolError::InvalidParams(format!("edits[{index}].find must be a non-empty string"))
        })?;
        let replace = edit.get("replace").and_then(Value::as_str).ok_or_else(|| {
            ToolError::InvalidParams(format!("edits[{index}].replace must be a string"))
        })?;
        if find.is_empty() || find.len() > MAX_CANVAS_REVISION_EDIT_CHARS {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}].find must contain 1 to {MAX_CANVAS_REVISION_EDIT_CHARS} bytes"
            )));
        }
        if replace.len() > MAX_CANVAS_REVISION_EDIT_CHARS {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}].replace exceeds {MAX_CANVAS_REVISION_EDIT_CHARS} bytes"
            )));
        }
        if find == replace {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}] must change the matched source"
            )));
        }
        if edit.get("all").is_some_and(|value| !value.is_boolean()) {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}].all must be a boolean"
            )));
        }
    }
    Ok(())
}

fn validate_canvas_revision_agent_steps(params: &Value) -> Result<(), ToolError> {
    let steps = params
        .get("agent_steps")
        .and_then(Value::as_array)
        .ok_or_else(|| ToolError::InvalidParams("missing required field: agent_steps".into()))?;
    if steps.is_empty() || steps.len() > MAX_CANVAS_REVISION_AGENT_STEPS {
        return Err(ToolError::InvalidParams(format!(
            "field \"agent_steps\" must contain 1 to {MAX_CANVAS_REVISION_AGENT_STEPS} labels"
        )));
    }

    for (index, step) in steps.iter().enumerate() {
        let label = step.as_str().ok_or_else(|| {
            ToolError::InvalidParams(format!("agent_steps[{index}] must be a string"))
        })?;
        let character_count = label.trim().chars().count();
        if character_count == 0 || character_count > MAX_CANVAS_REVISION_AGENT_STEP_CHARS {
            return Err(ToolError::InvalidParams(format!(
                "agent_steps[{index}] must contain 1 to {MAX_CANVAS_REVISION_AGENT_STEP_CHARS} characters after trimming whitespace"
            )));
        }
    }
    Ok(())
}

fn validate_canvas_payload(params: &Value, allow_edits: bool) -> Result<(), ToolError> {
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidParams("missing required field: mode".into()))?;

    let edits = canvas_revision_edits(params);
    if allow_edits {
        validate_canvas_revision_agent_steps(params)?;
    } else if params.get("agent_steps").is_some() {
        return Err(ToolError::InvalidParams(
            "field \"agent_steps\" is only available on revise_inline_canvas".into(),
        ));
    }
    if edits.is_some() && !allow_edits {
        return Err(ToolError::InvalidParams(
            "field \"edits\" is only available on revise_inline_canvas".into(),
        ));
    }

    if let Some(edits) = edits {
        if params.get("content").is_some() || params.get("url").is_some() {
            return Err(ToolError::InvalidParams(
                "use either edits or a complete content/url replacement, not both".into(),
            ));
        }
        if mode == "url" {
            return Err(ToolError::InvalidParams(
                "targeted edits require a source-backed html, a2ui, or react Canvas".into(),
            ));
        }
        validate_canvas_revision_edits(edits)?;
        return Ok(());
    }

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

    Ok(())
}

fn canvas_acceptance(tool_name: &str, params: &Value, call_id: &str) -> String {
    let mode = params
        .get("mode")
        .and_then(Value::as_str)
        .expect("validated canvas mode");
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("(no title)");
    let content_len = params
        .get("content")
        .and_then(Value::as_str)
        .map(str::len)
        .unwrap_or(0);
    let url = params.get("url").and_then(Value::as_str).unwrap_or("");

    let mut acceptance = if let Some(edit_count) = canvas_revision_edits(params).map(Vec::len) {
        format!(
            "{tool_name}: accepted {edit_count} targeted source edit(s), title=\"{title}\"; visual output not verified"
        )
    } else {
        format_canvas_acceptance(tool_name, mode, content_len, title, url)
    };

    // Surface this Canvas version's event id so the model can address it as
    // `target_event_id` in a later revise_inline_canvas call — the id is
    // otherwise invisible to the LLM (it only exists in the event pipeline).
    if !call_id.is_empty() {
        let event_id = tool_names::tool_call_event_id(call_id);
        acceptance.push_str(&format!(
            "; event_id=\"{event_id}\" (pass as target_event_id to revise this Canvas)"
        ));
    }
    acceptance
}

fn apply_canvas_revision_edits(source: &str, edits: &[Value]) -> Result<String, ToolError> {
    validate_canvas_revision_edits(edits)?;
    let mut content = source.to_string();

    for (index, edit) in edits.iter().enumerate() {
        let find = edit
            .get("find")
            .and_then(Value::as_str)
            .expect("validated edit find");
        let replace = edit
            .get("replace")
            .and_then(Value::as_str)
            .expect("validated edit replace");
        let replace_all = edit.get("all").and_then(Value::as_bool).unwrap_or(false);
        let matches = content.match_indices(find).count();
        if matches == 0 {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}].find no longer matches the current Canvas source"
            )));
        }
        if !replace_all && matches != 1 {
            return Err(ToolError::InvalidParams(format!(
                "edits[{index}].find matched {matches} times; make it unique or set all=true deliberately"
            )));
        }
        content = if replace_all {
            content.replace(find, replace)
        } else {
            content.replacen(find, replace, 1)
        };
    }

    Ok(content)
}

/// Fetch the revision target's row once and validate that it identifies an
/// inline Canvas in the dispatching session. Returns the stored raw
/// `args_json` so the compact-edits path can materialize without re-fetching
/// the same row.
fn load_validated_canvas_target(
    connection: &Connection,
    session_id: &str,
    target_event_id: &str,
) -> Result<String, ToolError> {
    let row = connection
        .query_row(
            "SELECT function_name, args_json FROM events WHERE session_id = ?1 AND id = ?2 LIMIT 1",
            rusqlite::params![session_id, target_event_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| {
            ToolError::ExecutionFailed(format!(
                "could not validate Canvas revision target: {error}"
            ))
        })?;

    let Some((function_name, args_json)) = row else {
        return Err(ToolError::InvalidParams(format!(
            "target_event_id \"{target_event_id}\" does not identify an inline Canvas in the current session"
        )));
    };
    match function_name.as_deref() {
        Some(tool_names::RENDER_INLINE_CANVAS | tool_names::REVISE_INLINE_CANVAS) => Ok(args_json),
        Some(other) => Err(ToolError::InvalidParams(format!(
            "target_event_id \"{target_event_id}\" identifies {other}, not an inline Canvas"
        ))),
        None => Err(ToolError::InvalidParams(format!(
            "target_event_id \"{target_event_id}\" does not identify an inline Canvas in the current session"
        ))),
    }
}

fn load_materialized_canvas_args(
    connection: &Connection,
    session_id: &str,
    event_id: &str,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<Value, ToolError> {
    if depth >= MAX_CANVAS_REVISION_CHAIN_DEPTH {
        return Err(ToolError::InvalidParams(format!(
            "Canvas revision chain exceeds the supported depth of {MAX_CANVAS_REVISION_CHAIN_DEPTH}; send a complete replacement via \"content\" instead of \"edits\" to reset the chain"
        )));
    }
    if !visited.insert(event_id.to_string()) {
        return Err(ToolError::InvalidParams(format!(
            "Canvas revision chain is cyclic: event \"{event_id}\" appears more than once in the target chain"
        )));
    }

    let args_json = load_validated_canvas_target(connection, session_id, event_id)?;
    let args: Value = serde_json::from_str(&args_json).map_err(|error| {
        ToolError::ExecutionFailed(format!("stored Canvas arguments are invalid JSON: {error}"))
    })?;
    materialize_canvas_args(connection, session_id, args, visited, depth)
}

/// Resolve a compact-edits revision against its parent chain. Args without
/// `edits` (full renders and complete replacements) are already materialized
/// and pass through unchanged.
fn materialize_canvas_args(
    connection: &Connection,
    session_id: &str,
    args: Value,
    visited: &mut HashSet<String>,
    depth: usize,
) -> Result<Value, ToolError> {
    let Some(edits) = canvas_revision_edits(&args) else {
        return Ok(args);
    };
    let parent_id = args
        .get("target_event_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ToolError::InvalidParams("stored compact Canvas revision has no target_event_id".into())
        })?;
    let mut materialized =
        load_materialized_canvas_args(connection, session_id, parent_id, visited, depth + 1)?;
    let source = materialized
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ToolError::InvalidParams("target Canvas has no patchable source content".into())
        })?;
    let content = apply_canvas_revision_edits(source, edits)?;
    let object = materialized.as_object_mut().ok_or_else(|| {
        ToolError::ExecutionFailed("stored Canvas arguments must be an object".into())
    })?;
    object.insert("content".into(), Value::String(content));
    if let Some(title) = args.get("title").and_then(Value::as_str) {
        object.insert("title".into(), Value::String(title.to_string()));
    }
    Ok(materialized)
}

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

impl ReviseInlineCanvasTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReviseInlineCanvasTool {
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
        "Render interactive UI directly inside the chat panel as an inline canvas card.\n\
         Use this for interactive sketches, wireframes, product prototypes, data\n\
         visualisations, live previews, or structured output without leaving the conversation.\n\n\
         Modes:\n\
         - \"html\": Render a self-contained HTML/SVG/CSS snippet. Inline all styles;\n\
           scripts and event-handler attributes are removed, so this mode is static.\n\
         - \"url\": Present an HTTPS URL as an external-open action. Suitable for live\n\
           dashboards or documentation pages.\n\
         - \"a2ui\": Stream a sequence of typed UI elements as JSONL lines. Each line is\n\
           a JSON object with a \"type\" field. Supported types:\n\
           heading | text | code | image | button | divider | list | table | chart | form\n\
         - \"react\": Render a self-contained React App component in the preview runtime.\n\
           JSX and React hooks are supported. Do not use imports; define or default-export\n\
           an App component and call hooks through React, for example React.useState.\n\
           Runtime errors are displayed inside the preview. Keep generated code local-only:\n\
           do not access network APIs, browser storage, filesystem APIs, or app globals.\n\n\
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
         - Prefer \"react\" for clickable wireframes, multi-step flows, tabs, forms, and\n\
           other interaction sketches that need local state.\n\
         - Prefer \"html\" only for static bespoke layouts that none of the a2ui types can express.\n\
         - Keep HTML payloads under 64 KB for smooth rendering.\n\
         - Always set a descriptive \"title\" — it appears in the card header.\n\
         - This tool creates a new logical Canvas. For a Canvas Design request or any\n\
           update to an existing Canvas, call revise_inline_canvas instead; do not call\n\
           render_inline_canvas for the revised payload.\n\
         - A successful tool result only confirms that the payload was accepted by the UI.\n\
           It does not prove visual correctness. Do not claim the preview was visually\n\
           verified unless you inspected it through a screenshot or browser snapshot."
    }

    fn category(&self) -> &str {
        crate::tools::categories::GENERAL
    }

    fn is_read_only(&self) -> bool {
        true
    }

    fn parameters(&self) -> Value {
        canvas_parameters(false)
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        validate_canvas_payload(&params, false)?;

        // Return a concise confirmation — the actual content is not echoed back
        // to the LLM because it can be many KB of HTML/JSONL that would bloat
        // the context window. The frontend reads the canvas payload from the
        // `agent:tool_call` args (dispatched before this result arrives), so
        // the full content is already available without appearing in the LLM
        // tool_result message.
        Ok(canvas_acceptance(
            tool_names::RENDER_INLINE_CANVAS,
            &params,
            &ctx.call_id,
        ))
    }
}

#[async_trait]
impl Tool for ReviseInlineCanvasTool {
    fn name(&self) -> &str {
        tool_names::REVISE_INLINE_CANVAS
    }

    fn description(&self) -> &str {
        "Revise an existing inline Canvas in place without creating a second logical Canvas.\n\
         Use this for every Canvas Design request and for any follow-up that changes an\n\
         existing sketch. Pass the exact target event id supplied by the request. The\n\
         target must be an earlier render_inline_canvas or revise_inline_canvas event in\n\
         the current session. For localized copy, value, or style changes, prefer edits:\n\
         exact literal find/replace operations applied to the current materialized source.\n\
         Include enough surrounding source in find to make it unique; set all=true only\n\
         when every occurrence should change. For structural revisions, return the complete\n\
         replacement content instead. Generate agent_steps for the current request: 1 to 6\n\
         short factual user-visible operation labels in the user's language, ordered and\n\
         specific to the requested change, never a fixed template or private reasoning. Emit agent_steps before edits\n\
         or content so they can appear while the remaining arguments stream. Before calling\n\
         this tool, send one short factual\n\
         user-visible update naming the concrete change; do not expose private chain-of-thought.\n\
         Preserve unrelated content, behavior, local state,\n\
         and styling. Supports html, url, a2ui, and react modes. A successful\n\
         result confirms acceptance only; do not claim visual verification without inspection."
    }

    fn category(&self) -> &str {
        crate::tools::categories::GENERAL
    }

    fn is_read_only(&self) -> bool {
        // Deliberately NOT read-only even though execute_text only reads:
        // `is_concurrency_safe()` defaults to this flag, and it is the
        // parallel-execution gate. Revision validation reads the `events`
        // row that the event pipeline persists fire-and-forget, so a
        // render+revise (or revise+revise) pair in one LLM message must
        // serialize instead of racing a lagging store — and the tool is
        // mutating-by-nature (it replaces an existing Canvas). The flag has
        // no permission/approval side-effects: read-only tool policy is the
        // name-based `READ_ONLY_DENY_TOOLS` list, not `is_read_only`.
        false
    }

    fn parameters(&self) -> Value {
        canvas_parameters(true)
    }

    async fn execute_text(
        &self,
        params: Value,
        ctx: &crate::tools::traits::CallContext,
    ) -> Result<String, ToolError> {
        validate_canvas_payload(&params, true)?;

        let target_event_id = params
            .get("target_event_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                ToolError::InvalidParams("missing required field: target_event_id".into())
            })?;

        let session_id = ctx.session_id.trim().to_string();
        if session_id.is_empty() {
            return Err(ToolError::ExecutionFailed(
                "Canvas revision requires a dispatching session id".into(),
            ));
        }
        if !ctx.call_id.is_empty() && target_event_id == tool_names::tool_call_event_id(&ctx.call_id)
        {
            return Err(ToolError::InvalidParams(
                "target_event_id cannot identify the revision call itself".into(),
            ));
        }

        // The target lookup and chain materialization are synchronous
        // rusqlite queries; run them on the blocking pool instead of
        // stalling the async executor.
        let params = tokio::task::spawn_blocking(move || -> Result<Value, ToolError> {
            let connection = crate::foundation::db_bridge::get_connection().map_err(|error| {
                ToolError::ExecutionFailed(format!(
                    "could not open session persistence to validate Canvas target: {error}"
                ))
            })?;
            let target_args_json =
                load_validated_canvas_target(&connection, &session_id, &target_event_id)?;

            if let Some(edits) = canvas_revision_edits(&params) {
                let target_args: Value =
                    serde_json::from_str(&target_args_json).map_err(|error| {
                        ToolError::ExecutionFailed(format!(
                            "stored Canvas arguments are invalid JSON: {error}"
                        ))
                    })?;
                // The target is depth 0 of the revision chain; its row was
                // already fetched above, so materialize from those args
                // directly instead of re-fetching.
                let mut visited = HashSet::new();
                visited.insert(target_event_id.clone());
                let target_args =
                    materialize_canvas_args(&connection, &session_id, target_args, &mut visited, 0)?;
                let target_mode = target_args
                    .get("mode")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ToolError::InvalidParams("target Canvas has no valid rendering mode".into())
                    })?;
                let requested_mode = params
                    .get("mode")
                    .and_then(Value::as_str)
                    .expect("validated Canvas mode");
                if requested_mode != target_mode {
                    return Err(ToolError::InvalidParams(format!(
                        "targeted edits cannot change Canvas mode from {target_mode} to {requested_mode}; use a complete replacement"
                    )));
                }
                let source = target_args
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ToolError::InvalidParams(
                            "target Canvas has no patchable source content".into(),
                        )
                    })?;
                apply_canvas_revision_edits(source, edits)?;
            }

            Ok(params)
        })
        .await
        .map_err(|error| {
            ToolError::ExecutionFailed(format!(
                "Canvas revision validation task failed: {error}"
            ))
        })??;

        Ok(canvas_acceptance(
            tool_names::REVISE_INLINE_CANVAS,
            &params,
            &ctx.call_id,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        apply_canvas_revision_edits, canvas_acceptance, format_canvas_acceptance,
        load_materialized_canvas_args, load_validated_canvas_target, validate_canvas_payload,
        RenderInlineCanvasTool, ReviseInlineCanvasTool, MAX_CANVAS_REVISION_CHAIN_DEPTH,
    };
    use crate::tools::names as tool_names;
    use crate::tools::traits::{CallContext, Tool, ToolError};
    use rusqlite::{params, Connection};
    use serde_json::json;

    #[test]
    fn acceptance_does_not_claim_visual_success() {
        let result = format_canvas_acceptance(
            tool_names::RENDER_INLINE_CANVAS,
            "html",
            42,
            "Prototype",
            "",
        );

        assert!(result.contains("accepted html content"));
        assert!(result.contains("visual output not verified"));
        assert!(!result.contains("rendered html content"));
    }

    #[test]
    fn url_acceptance_does_not_claim_embedding_succeeded() {
        let result = format_canvas_acceptance(
            tool_names::RENDER_INLINE_CANVAS,
            "url",
            0,
            "Docs",
            "https://example.com",
        );

        assert!(result.contains("accepted url=\"https://example.com\""));
        assert!(result.contains("visual output not verified"));
        assert!(!result.contains("embedded url"));
    }

    #[test]
    fn description_routes_interactive_sketches_to_stateful_react() {
        let tool = RenderInlineCanvasTool::new();
        let description = tool.description();

        assert!(description.contains("interactive sketches"));
        assert!(description.contains("multi-step flows"));
        assert!(description.contains("React.useState"));
        assert!(!description.contains("JSX is not transformed"));
        assert!(!description.contains("Hooks and ReactDOM APIs are not available"));
    }

    #[test]
    fn creation_and_revision_have_distinct_identity_contracts() {
        let creation_schema = RenderInlineCanvasTool::new().parameters();
        let creation_properties = creation_schema["properties"]
            .as_object()
            .expect("render_inline_canvas properties");
        assert!(!creation_properties.contains_key("revises_event_id"));
        assert!(!creation_properties.contains_key("target_event_id"));

        let revision_schema = ReviseInlineCanvasTool::new().parameters();
        let revision_properties = revision_schema["properties"]
            .as_object()
            .expect("revise_inline_canvas properties");
        assert!(revision_properties.contains_key("target_event_id"));
        assert!(revision_properties.contains_key("edits"));
        assert!(revision_properties.contains_key("agent_steps"));
        assert_eq!(
            revision_schema["required"],
            json!(["target_event_id", "mode", "agent_steps"])
        );
        assert_eq!(revision_schema["additionalProperties"], false);
    }

    #[test]
    fn compact_revision_acceptance_reports_edits_without_echoing_source() {
        let result = canvas_acceptance(
            tool_names::REVISE_INLINE_CANVAS,
            &json!({
                "target_event_id": "canvas-a",
                "mode": "react",
                "edits": [{"find": "Start", "replace": "Start setup"}]
            }),
            "call-revision",
        );

        assert!(result.contains("accepted 1 targeted source edit"));
        assert!(result.contains("visual output not verified"));
        assert!(!result.contains("Start setup"));
    }

    #[test]
    fn acceptance_carries_the_canvas_event_id_for_later_revisions() {
        let result = canvas_acceptance(
            tool_names::RENDER_INLINE_CANVAS,
            &json!({"mode": "html", "content": "<div></div>"}),
            "call-1",
        );
        assert!(result.contains("event_id=\"tool-call-call-1\""));
        assert!(result.contains("target_event_id"));

        // Maintenance/test dispatches without a call id must not fabricate
        // a dangling event id.
        let without_call_id = canvas_acceptance(
            tool_names::RENDER_INLINE_CANVAS,
            &json!({"mode": "html", "content": "<div></div>"}),
            "",
        );
        assert!(!without_call_id.contains("event_id="));
    }

    #[test]
    fn revision_description_requests_a_factual_visible_progress_update() {
        let tool = ReviseInlineCanvasTool::new();
        let description = tool.description();

        assert!(description.contains("user-visible update"));
        assert!(description.contains("do not expose private chain-of-thought"));
        assert!(description.contains("prefer edits"));
        assert!(description.contains("never a fixed template"));
        assert!(description.contains("user's language"));
        assert!(description.contains("Emit agent_steps before edits"));
    }

    #[test]
    fn revision_requires_bounded_agent_generated_steps() {
        let missing = validate_canvas_payload(
            &json!({
                "target_event_id": "canvas-a",
                "mode": "react",
                "content": "function App() { return null; }"
            }),
            true,
        );
        assert!(matches!(
            missing,
            Err(ToolError::InvalidParams(message)) if message.contains("agent_steps")
        ));

        let whitespace = validate_canvas_payload(
            &json!({
                "target_event_id": "canvas-a",
                "mode": "react",
                "agent_steps": ["   "],
                "content": "function App() { return null; }"
            }),
            true,
        );
        assert!(matches!(
            whitespace,
            Err(ToolError::InvalidParams(message)) if message.contains("agent_steps[0]")
        ));

        assert!(validate_canvas_payload(
            &json!({
                "target_event_id": "canvas-a",
                "mode": "react",
                "agent_steps": ["替换按钮文案", "核对原有交互"],
                "content": "function App() { return null; }"
            }),
            true,
        )
        .is_ok());
    }

    #[test]
    fn compact_edits_require_a_unique_match_by_default() {
        let ambiguous = apply_canvas_revision_edits(
            "Same Same",
            &[json!({"find": "Same", "replace": "Changed"})],
        );
        assert!(matches!(
            ambiguous,
            Err(ToolError::InvalidParams(message)) if message.contains("matched 2 times")
        ));

        let replaced = apply_canvas_revision_edits(
            "Same Same",
            &[json!({"find": "Same", "replace": "Changed", "all": true})],
        )
        .expect("replace-all edit");
        assert_eq!(replaced, "Changed Changed");
    }

    #[test]
    fn materializes_compact_revision_chains_from_persisted_events() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute(
                "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL
                )",
                [],
            )
            .expect("events table");
        connection
            .execute(
                "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    "canvas-a",
                    "session-a",
                    tool_names::RENDER_INLINE_CANVAS,
                    json!({"mode": "react", "content": "Start Keep"}).to_string()
                ],
            )
            .expect("base canvas");
        connection
            .execute(
                "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
                params![
                    "canvas-b",
                    "session-a",
                    tool_names::REVISE_INLINE_CANVAS,
                    json!({
                        "target_event_id": "canvas-a",
                        "mode": "react",
                        "edits": [{"find": "Start", "replace": "Start setup"}]
                    })
                    .to_string()
                ],
            )
            .expect("compact revision");

        let args = load_materialized_canvas_args(
            &connection,
            "session-a",
            "canvas-b",
            &mut std::collections::HashSet::new(),
            0,
        )
        .expect("materialized Canvas");
        assert_eq!(args["content"], "Start setup Keep");
    }

    #[tokio::test]
    async fn revision_rejects_an_empty_target_before_persistence_lookup() {
        let result = ReviseInlineCanvasTool::new()
            .execute_text(
                json!({
                    "target_event_id": "  ",
                    "mode": "react",
                    "agent_steps": ["定位目标"],
                    "content": "function App() { return null; }"
                }),
                &CallContext::new("call-revision", "session-a"),
            )
            .await;

        assert!(
            matches!(result, Err(ToolError::InvalidParams(message)) if message.contains("target_event_id"))
        );
    }

    #[test]
    fn revision_target_must_be_a_canvas_in_the_same_session() {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute(
                "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL DEFAULT '{}'
                )",
                [],
            )
            .expect("events table");
        connection
            .execute(
                "INSERT INTO events (id, session_id, function_name) VALUES (?1, ?2, ?3)",
                params!["canvas-a", "session-a", tool_names::RENDER_INLINE_CANVAS],
            )
            .expect("canvas event");
        connection
            .execute(
                "INSERT INTO events (id, session_id, function_name) VALUES (?1, ?2, ?3)",
                params!["read-a", "session-a", tool_names::READ_FILE],
            )
            .expect("non-canvas event");

        assert!(load_validated_canvas_target(&connection, "session-a", "canvas-a").is_ok());
        assert!(matches!(
            load_validated_canvas_target(&connection, "session-b", "canvas-a"),
            Err(ToolError::InvalidParams(_))
        ));
        assert!(matches!(
            load_validated_canvas_target(&connection, "session-a", "read-a"),
            Err(ToolError::InvalidParams(_))
        ));
    }

    fn canvas_chain_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database");
        connection
            .execute(
                "CREATE TABLE events (
                    id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    function_name TEXT,
                    args_json TEXT NOT NULL
                )",
                [],
            )
            .expect("events table");
        connection
    }

    fn insert_canvas_event(
        connection: &Connection,
        id: &str,
        function_name: &str,
        args: serde_json::Value,
    ) {
        connection
            .execute(
                "INSERT INTO events (id, session_id, function_name, args_json) VALUES (?1, ?2, ?3, ?4)",
                params![id, "session-a", function_name, args.to_string()],
            )
            .expect("insert canvas event");
    }

    #[test]
    fn cyclic_revision_chain_reports_the_cycle() {
        let connection = canvas_chain_connection();
        insert_canvas_event(
            &connection,
            "canvas-a",
            tool_names::REVISE_INLINE_CANVAS,
            json!({
                "target_event_id": "canvas-b",
                "mode": "react",
                "edits": [{"find": "x", "replace": "y"}]
            }),
        );
        insert_canvas_event(
            &connection,
            "canvas-b",
            tool_names::REVISE_INLINE_CANVAS,
            json!({
                "target_event_id": "canvas-a",
                "mode": "react",
                "edits": [{"find": "x", "replace": "y"}]
            }),
        );

        let result = load_materialized_canvas_args(
            &connection,
            "session-a",
            "canvas-a",
            &mut std::collections::HashSet::new(),
            0,
        );
        assert!(matches!(
            result,
            Err(ToolError::InvalidParams(message))
                if message.contains("cyclic") && !message.contains("depth")
        ));
    }

    #[test]
    fn deep_revision_chain_tells_the_agent_how_to_reset() {
        let connection = canvas_chain_connection();
        insert_canvas_event(
            &connection,
            "canvas-0",
            tool_names::RENDER_INLINE_CANVAS,
            json!({"mode": "react", "content": "base"}),
        );
        for index in 1..=MAX_CANVAS_REVISION_CHAIN_DEPTH + 1 {
            insert_canvas_event(
                &connection,
                &format!("canvas-{index}"),
                tool_names::REVISE_INLINE_CANVAS,
                json!({
                    "target_event_id": format!("canvas-{}", index - 1),
                    "mode": "react",
                    "edits": [{"find": "x", "replace": "y"}]
                }),
            );
        }

        let result = load_materialized_canvas_args(
            &connection,
            "session-a",
            &format!("canvas-{}", MAX_CANVAS_REVISION_CHAIN_DEPTH + 1),
            &mut std::collections::HashSet::new(),
            0,
        );
        assert!(matches!(
            result,
            Err(ToolError::InvalidParams(message))
                if message.contains("exceeds the supported depth")
                    && message.contains("complete replacement")
                    && !message.contains("cyclic")
        ));
    }
}
