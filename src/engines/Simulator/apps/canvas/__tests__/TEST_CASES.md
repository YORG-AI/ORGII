# Test Cases: Canvas Revision Streaming

## Preconditions

- A session contains at least one valid `render_inline_canvas` event.
- The Canvas app is open on that event and the agent supports tool-call deltas.

## Happy Path

| #   | Steps                                                                      | Expected Result                                                                                                                                              |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Select an element in Design mode and request a localized copy/style change | The existing Canvas remains visible and a live “Updating Canvas” status appears as revision arguments arrive.                                                |
| 2   | Let a compact `edits` revision finish                                      | The exact source match changes in the existing logical Canvas; unrelated source and UI state remain intact.                                                  |
| 3   | Request a structural change that uses complete replacement content         | The existing full-replacement revision path still updates the same logical Canvas.                                                                           |
| 4   | Observe the chat after either revision completes                           | A persistent “Updated Canvas” activity remains with locate, generate, and apply/validate steps; no duplicate Canvas preview is added.                        |
| 5   | Select a Canvas element and open the contextual composer                   | The shared compact capsule appears in one row with the selected-element pill, editor, model controls, microphone, and send action.                           |
| 6   | Click the completed “Updated Canvas” activity header or its navigate icon  | Replay locates that revision event, Agent Station opens the Canvas app, and the corresponding logical Canvas is selected at its latest materialized version. |
| 7   | Hover the selected-element reference and click it                          | Its pointer icon changes to the shared editor-pill close icon; activating it clears the selection and closes the contextual composer.                        |

## Edge Cases

| #   | Scenario                                | Steps                                                                    | Expected Result                                                                                                                   |
| --- | --------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Metadata is incomplete                  | Observe the first tool-call delta before `target_event_id` closes        | Generic Canvas progress appears without rendering incomplete React source.                                                        |
| 2   | Ambiguous exact match                   | Send an edit whose `find` occurs twice without `all=true`                | Backend rejects the revision and the last valid Canvas remains visible.                                                           |
| 3   | Deliberate replace all                  | Send an edit with `all=true`                                             | Every exact occurrence changes and no other text is modified.                                                                     |
| 4   | Rapid delta burst                       | Stream many argument fragments                                           | UI updates are coalesced to at most 20Hz; the final character count is not lost.                                                  |
| 5   | Newer operation supersedes old terminal | Start a new revision before a late terminal from the previous id         | The stale terminal cannot clear the newer progress state.                                                                         |
| 6   | Provider emits no reasoning stream      | Complete a short revision with no thinking event                         | The UI shows factual Canvas work steps but does not invent or label them as private model reasoning.                              |
| 7   | Selection reference with an empty draft | Open the contextual composer and do not type                             | The reference remains visual-only; the input is still logically empty and the placeholder remains visible.                        |
| 8   | Revision activity missing an event id   | Render a legacy/incomplete activity without a stable event id            | The activity remains readable but has no pointer cursor or navigate affordance; no navigation is attempted.                       |
| 9   | Narrow chat column                      | Render a revision with a long Canvas title and change summary            | The activity title and summary stay within the row, truncate with an ellipsis, and retain native hover text.                      |
| 10  | Multiline Design instruction            | Type a newline or enough structured content to make the editor multiline | The shared composer expands out of the capsule without remounting the editor or losing the selection reference, caret, or draft.  |
| 11  | Wide Canvas viewport                    | Select an element in a Canvas wider than the Design composer             | The composer stays centered at no more than 640px, and only the shared `ComposerShell` paints its background, border, and radius. |

## Error / Degraded States

| #   | Scenario                       | Steps                                                          | Expected Result                                                                                    |
| --- | ------------------------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | User stops the turn            | Stop while revision arguments are streaming                    | Progress clears and the previous valid Canvas remains unchanged.                                   |
| 2   | Tool validation fails          | Use stale source text or change rendering mode through `edits` | Failed revision is shown in chat; Simulator keeps the previous valid Canvas.                       |
| 3   | Session switches or is deleted | Leave/remove the session during generation                     | Pending timer and session-scoped draft state are released; no progress leaks into another session. |

## Accessibility

- [ ] Progress uses `role="status"` and polite live announcements.
- [ ] Completed work steps remain readable without relying on color alone.
- [ ] Progress is readable in light and dark themes.
- [ ] Reduced-motion disables the spinner animation.
- [ ] Design controls remain visible but disabled while a revision is active.
- [ ] The selected-element reference and editor text share one visual line at normal zoom and remain readable in both themes.
- [ ] Focus order across the compact Design composer follows selected reference, editor, model controls, microphone, and send action.
- [ ] The selected-element reference is keyboard operable and exposes a clear-selection accessible name; hover changes its icon to a close glyph.
- [ ] The Canvas revision activity exposes the shared navigate affordance on hover, and the full header hit area opens the same destination.

## Acceptance Criteria

- [ ] Canvas revision progress appears on the first identifiable tool-call delta.
- [ ] Incomplete React/HTML source is never rendered over the last valid Canvas.
- [ ] Localized changes can use compact exact edits instead of a full Canvas payload.
- [ ] Full replacement revisions remain backward compatible.
- [ ] Final, failed, cancelled, switched, and deleted sessions release transient revision state.
- [ ] A completed or failed revision keeps one persistent work record in chat history without a second Canvas card.
- [ ] Canvas selection context is rendered as an inline editor adornment and is not duplicated into the typed instruction.
- [ ] A single-line Design prompt uses the shared compact `ComposerShell`/`ComposerBar` layout and expands safely for multiline input.
- [ ] The Design prompt has one visual shell, no mismatched rounded background behind it, and never exceeds 640px.
- [ ] Long Canvas revision titles and summaries cannot overflow the chat activity row.
- [ ] Completed, running, failed, and chained revision events navigate through the existing replay/Canvas projection path; missing event ids remain inert.
