# Test Cases: AgentErrorChatItem (error message sanitization)

Covers the defensive display layer for agent/LLM error messages, primarily the
`sanitizeAgentErrorMessage` helper that feeds `AgentErrorChatItem`.

## Preconditions

- An agent turn has failed and an `AgentErrorChatItem` is rendered with an
  `errorMessage` string produced by the Rust providers layer.
- The message is rendered as plain text inside a `whitespace-pre-wrap` block
  (never via `dangerouslySetInnerHTML`).

## Happy Path

| #   | Steps                                                                                       | Expected Result                          |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | Backend returns a clean message `LLM error: Request failed: HTTP 500 Internal Server Error` | Rendered verbatim (no HTML, single line) |
| 2   | Backend returns a structured JSON error `HTTP 400: {"error":{"message":"bad model"}}`       | Rendered verbatim, JSON preserved        |

## Edge Cases

| #   | Scenario                                        | Steps                                                                                                  | Expected Result                                                          |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1   | Raw HTML 500 page leaks through (older backend) | `errorMessage = "LLM error: Request failed: HTTP 500: <!doctype html>...500 Internal Server Error..."` | Collapsed to `LLM error: Request failed: HTTP 500 Internal Server Error` |
| 2   | HTML page with no surrounding prose             | `errorMessage = "<!doctype html>...<title>500 Internal Server Error</title>..."`                       | `HTTP 500 Internal Server Error`                                         |
| 3   | Unknown status code with `<title>`              | `errorMessage = "Request failed: HTTP 599: <html><title>Edge Gateway Down</title>..."`                 | `Request failed: HTTP 599 Edge Gateway Down`                             |
| 4   | HTML with neither status nor title              | `<html><body><h1>broken</h1></body></html>`                                                            | `Server error`                                                           |
| 5   | Empty / null message                            | `errorMessage = ""`                                                                                    | Empty string (panel shows title only)                                    |
| 6   | Leading `Error:` prefix                         | `"Error: something broke"`                                                                             | `something broke`                                                        |
| 7   | Excessive blank lines                           | `"line one\n\n\n\nline two"`                                                                           | Blank runs collapsed to a single blank line                              |
| 8   | Very long body (2000 chars)                     | `"x".repeat(2000)`                                                                                     | Truncated to 600 chars ending with `…`                                   |
| 9   | Multibyte / padded whitespace                   | `"   padded message   "`                                                                               | Trimmed to `padded message`                                              |

## Error / Degraded States

| #   | Scenario                          | Steps                 | Expected Result                            |
| --- | --------------------------------- | --------------------- | ------------------------------------------ |
| 1   | Backend offline / generic failure | Non-HTTP error string | Passed through, trimmed and length-bounded |

## Accessibility

- [x] Message is plain text (screen-reader friendly), never injected HTML.
- [x] Resume button keyboard-navigable (existing `Button` component).
- [x] Danger `InlineAlert` provides a titled, bordered region.

## Acceptance Criteria

- [x] Raw HTML error pages never render as markup or as multi-line raw HTML.
- [x] HTTP errors surface as `HTTP <code> <reason phrase>`.
- [x] Structured/plain messages are preserved unchanged.
- [x] Output is length-bounded and whitespace-normalized.
- [x] Logic is extracted to a tested `.ts` helper (`sanitizeAgentErrorMessage`).

---

# Test Cases: Raw prompt inspector (user turns)

Covers the per-turn "view raw prompt" affordance on `UserChatItem`: the
`resolveRawUserPrompt` reader that defines what "raw" means, and the
`RawPromptToggle` button + panel that surfaces it.

## Preconditions

- A user turn is rendered as a `UserChatItem` bubble in chat history.
- The turn's wire content lives on `event.result.message.content` (written by
  `persist_user_message_event` for native turns, `user_message_chunk` for
  imported ones). The bubble itself renders a _transformed_ copy of that
  string: pills as badges, expansion block stripped, envelope normalized.

## Happy Path

| #   | Steps                                                                 | Expected Result                                                                  |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Hover a user turn that carries wire content                           | A `{}` (Braces) button appears in the message toolbar, beside Copy               |
| 2   | Click it                                                              | A panel opens below, titled "Raw prompt sent to AI"                              |
| 3   | Read the panel header                                                 | Subtitle reads `<model> [effort] · <n> chars`; Copy action sits at the right     |
| 4   | Read the panel body                                                   | The wire string verbatim, monospace — pill tokens NOT rendered as badges         |
| 5   | Click the trigger again, or press Escape, or click outside            | Panel closes                                                                     |
| 6   | Open the panel on a turn whose pills were expanded by `pill_resolver` | The `**Referenced content (auto-expanded):**` block the bubble strips is present |

## Edge Cases

| #   | Scenario                                           | Steps                                                                               | Expected Result                                                        |
| --- | -------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `displayText` is the short pill form               | Wire content is `skill [skill:/x]` + expansion; `displayText` is `skill [skill:/x]` | Panel shows the wire content, not `displayText`                        |
| 2   | External-CLI envelope                              | Wire content starts with `## Files mentioned by the user:`                          | Envelope kept verbatim (the bubble's normalizer does not apply)        |
| 3   | Legacy event with no `result.message`              | Only `displayText` is persisted                                                     | Falls back to `displayText` (still closer to the wire than the bubble) |
| 4   | `content` is `null`                                | `result.message.content = null`                                                     | Resolves to `""` → no trigger rendered                                 |
| 5   | Whitespace-only prompt (e.g. attachment-only turn) | `content = "   "`, message carries only `cached_files`                              | No trigger rendered; the rest of the toolbar is unaffected             |
| 6   | Session names no model                             | `session.model` unset                                                               | Header shows the length alone; no dangling `·` separator               |
| 6a  | Model id encodes reasoning effort                  | `session.model = claude-opus-4-7-thinking-xhigh`                                    | Header reads `Opus 4.7` + chip `Extra High · Thinking`                 |
| 6b  | Effort already present in the formatted id         | `session.model = gpt-5.3-codex-high`                                                | `GPT 5.3 Codex` + chip `High` — never `GPT 5.3 Codex High · High`      |
| 6c  | Model id encodes no variant                        | `session.model = claude-opus-4.5-20251219`                                          | No effort chip at all (effort is per-model, not universal)             |
| 6d  | Variant suffix parses but maps to no label         | `session.model = gpt-5.3-codex-minimal`                                             | Whole id formatted into the name; suffix is not silently dropped       |
| 7   | Very long prompt (expanded SKILL.md / file block)  | 12k-char wire content                                                               | Panel caps at 420px tall and scrolls; page does not scroll             |
| 8   | Panel opened near the viewport bottom / right edge | Trigger sits low or far right                                                       | `useDropdownEngine` flips above and clamps horizontally                |

## Error / Degraded States

| #   | Scenario                                             | Steps                                 | Expected Result                                                                               |
| --- | ---------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Event has no `sessionId`                             | Synthetic/placeholder row             | No trigger rendered (the model lookup has no key)                                             |
| 2   | Session row not yet in the store                     | Panel opened before session hydration | Header degrades to the length alone; body still shows the prompt                              |
| 3   | Mouse leaves the message row while the panel is open | Move the pointer onto the panel       | Toolbar stays visible (`isRawPromptOpen`), so the trigger does not vanish under its own panel |

## Accessibility

- [x] Trigger is a real `<button>` with `aria-label`, `aria-expanded`, and `aria-haspopup="dialog"`.
- [x] Panel is `role="dialog"` with an accessible name.
- [x] Escape closes the panel (document-level handler in `useDropdownEngine`).
- [x] Focus is not stolen from the trigger, so the hover-revealed toolbar stays visible via `focus-within`.
- [x] Panel body is selectable text (`allow-select`), never injected HTML.

## Acceptance Criteria

- [x] The panel shows the exact string the model received — no pill rendering, no stripping, no normalization.
- [x] The trigger is absent when there is no prompt text to show.
- [x] Reasoning effort is shown for exactly the model ids that encode it, and is never duplicated into the model name.
- [x] Opening the panel is the only thing that subscribes to the session (model lookup); closed bubbles pay nothing.
- [x] Copy in the panel copies the raw string, not the bubble text.
