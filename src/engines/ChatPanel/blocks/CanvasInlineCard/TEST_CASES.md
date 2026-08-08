# Test Cases: Canvas Inline Chat Handoff

## Preconditions

- A session is open in ChatPanel.
- The WorkStation Canvas app is visible or can be opened for the same session.
- The agent can invoke `render_inline_canvas`.

## Happy Path

| # | Steps | Expected Result |
|---|-------|-----------------|
| 1 | Ask the agent to generate an interactive canvas. | The Canvas card appears inline in ChatPanel without an intermediate generic gray loading bar. |
| 2 | Observe the WorkStation while the canvas tool call arrives. | WorkStation and ChatPanel show the same canvas payload for the same event. |
| 3 | Wait for the assistant's final prose message. | The inline Canvas card remains visible when the streaming message becomes historical. |

## Edge Cases

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Cold renderer cache | Open a fresh app window and generate a canvas as the first tool call. | ChatPanel preloads the renderer while the agent works and renders the card through the synchronous cache path. |
| 2 | Rapid finalization | Make `render_inline_canvas` complete immediately before the final assistant message. | No visible empty handoff appears between the live preview and persisted event card. |
| 3 | Session switch | Generate a canvas in session A, switch to session B, then return. | Session B never shows session A's preview; session A hydrates its persisted card. |
| 4 | Multiple canvases | Generate two canvases in consecutive turns. | Each historical tool event owns one inline card and the latest WorkStation selection advances normally. |

## Error / Degraded States

| # | Scenario | Steps | Expected Result |
|---|----------|-------|-----------------|
| 1 | Renderer chunk fails to load | Simulate a dynamic-import failure. | The existing activity error boundary reports the render failure; WorkStation data remains intact. |
| 2 | Invalid or empty payload | Invoke the tool without displayable content. | The Canvas card shows its existing empty or failed state and does not remove unrelated messages. |

## Accessibility

- [ ] Canvas header remains keyboard-operable for collapse and navigation.
- [ ] Loading and error states retain their existing accessible labels.
- [ ] Focus is not moved when the live preview becomes a historical card.

## Acceptance Criteria

- [ ] A preloaded `canvas_inline` event renders synchronously in ChatPanel without `ChatLoadingBlock`.
- [ ] WorkStation and ChatPanel continue to read the same persisted event payload.
- [ ] Final assistant-message arrival does not create a visible empty handoff.
- [ ] Canvas previews remain isolated by session.
- [ ] Non-canvas activity renderers are unchanged.
