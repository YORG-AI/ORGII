# Test Cases: ToolCallBlock

## Preconditions

- The `ToolCallBlock` is rendered inside a session `ChatPanel` context.
- Session is loaded with at least one tool-call event.
- `ToolCallBlockProps` supplies a `toolCall` with `tool_name`, `args`, and optionally `result`.

## Happy Path

| #   | Steps                                                 | Expected Result                                                                                   |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Render block for a generic tool call with args.       | Tool name and formatted action summary display; raw args stay hidden until the block is expanded. |
| 2   | Render block with a successful `result`.              | Result content displays below the header.                                                         |
| 3   | Render a `file_read` / `file_edit` tool call.         | `FileCard` variant renders with file path and diff info.                                          |
| 4   | Render a `run_command` / shell tool call with output. | `CommandResultCard` renders with exit code and output.                                            |
| 5   | Render a `web_fetch` / website tool call.             | `WebsiteCard` renders with URL.                                                                   |
| 6   | Render a `session_link` tool call.                    | `SessionLinkCard` renders with session reference.                                                 |
| 7   | Render an `agent_message` tool call.                  | `AgentMessageCard` renders with message content.                                                  |
| 8   | Render a search tool call with results.               | Results shown inline; no "no results" indicator.                                                  |
| 9   | Render a search tool call with no results.            | "No matches found" sentinel message displayed.                                                    |
| 10  | Click the expand/collapse toggle on the block.        | Output content collapses or expands accordingly.                                                  |

## Edge Cases

| #   | Scenario                                            | Steps                                                 | Expected Result                                                                           |
| --- | --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Streaming (in-progress) tool call                   | Render block with no `result` and `isStreaming=true`. | Loading indicator shown; expand/collapse disabled or hidden.                              |
| 2   | Error result                                        | Render with `isError=true` in result.                 | Error styling applied to block header or output area.                                     |
| 3   | Empty args object                                   | Render with `args={}`.                                | Block renders without args summary; no crash.                                             |
| 4   | Very long result text (> `TOOL_SNAPSHOT_MAX_CHARS`) | Render block with 50 KB result string.                | Text truncated at `TOOL_SNAPSHOT_MAX_CHARS`; "show more" or truncation indicator present. |
| 5   | Browser snapshot tool                               | Render `browser_snapshot` tool.                       | `BROWSER_SNAPSHOT_VISIBLE_LINES` applied; snapshot shown collapsed.                       |
| 6   | MCP tool with progress rows                         | Render tool call with MCP progress events.            | `McpProgressRow` renders each progress entry in order.                                    |
| 7   | Unknown tool name                                   | Render with unrecognized `tool_name`.                 | Falls back to generic `ToolCallBlock` display; no crash.                                  |
| 8   | `task_update` tool                                  | Render task update tool.                              | `TaskUpdateCard` renders with correct task title.                                         |
| 9   | `manage_workspace` result                           | Render manage_workspace tool with result.             | `parseManageWorkspaceResult` applied; result displayed correctly.                         |
| 10  | Null / undefined result                             | Render with `result=null`.                            | No output section rendered; no crash.                                                     |

## Error / Degraded States

| #   | Scenario                            | Steps                                    | Expected Result                                      |
| --- | ----------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| 1   | Result JSON parse failure           | Provide malformed JSON as result string. | Falls through to raw text display; no JS error.      |
| 2   | Missing `tool_name`                 | Render without `tool_name` prop.         | Fallback label shown; no crash.                      |
| 3   | `ToolResultActions` with no actions | Render block with empty actions list.    | No action buttons shown; no empty-element artifacts. |

## Accessibility

- [ ] Keyboard-navigable (Tab to expand/collapse button; Enter/Space to toggle)
- [ ] Screen reader label present on block header (tool name announced)
- [ ] Focus trap not applicable (inline block, not a modal)

## Acceptance Criteria

- [ ] Each known card variant renders its expected primary content
- [ ] Streaming state shows a loading indicator; result state shows content
- [ ] Error result applies visual error styling
- [ ] Result text truncated at `TOOL_SNAPSHOT_MAX_CHARS`; no DOM bloat
- [ ] Expand/collapse toggle correctly shows/hides output
- [ ] Generic raw tool blocks start collapsed, including failed calls
- [ ] Unknown tool names degrade gracefully to generic display
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors (`pnpm typecheck`)
