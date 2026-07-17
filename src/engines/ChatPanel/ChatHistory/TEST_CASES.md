# Test Cases: ChatHistory

## Preconditions

- Session is loaded with a non-empty event array.
- `ChatHistory` is rendered inside `ChatSessionContext`, Jotai provider, and i18n context.
- `GroupedVirtuoso` scroll container is mounted in a layout with measurable height.
- Pagination feature flag and `useChatPagination` hook are initialized.

## Happy Path

| #   | Steps                                               | Expected Result                                                                                                                                                 |
| --- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Disable pagination; open several turns.             | User messages render as right-aligned bubbles in chronological flow; scrolling does not pin or duplicate a turn header.                                         |
| 2   | Session is active; agent posts a new message.       | New item appended at bottom; auto-scroll follows if user was at bottom.                                                                                         |
| 3   | User sends a new message.                           | Optimistic turn added to list immediately.                                                                                                                      |
| 4   | Click "Collapse all" button.                        | All expanded tool-call blocks collapse; `collapseAllCommandAtom` fires.                                                                                         |
| 5   | Toggle collapse on an individual turn.              | `turnCollapseOverrideAtom` updates; only that turn collapses/expands.                                                                                           |
| 6   | Pagination enabled; history exceeds one page.       | In-list and pinned user messages use the same right-aligned bubble; pagination controls navigate to the adjacent page.                                          |
| 7   | Search bar opened; type a query.                    | `ChatSearchBar` highlights matching turns; non-matching items dimmed or filtered.                                                                               |
| 8   | Revert button clicked on a turn.                    | `RevertConfirmDialog` opens; confirming reverts session state.                                                                                                  |
| 9   | Agent is planning; planning indicator shown.        | `usePlanningIndicator` returns `true`; planning spinner/indicator visible.                                                                                      |
| 10  | Cursor IDE session with turn summaries.             | `cursorIdeTurnSummariesAtomFamily` data renders inline on matching turns.                                                                                       |
| 11  | Disable pagination; open a long conversation.       | A right-side conversation minimap shows at most 20 percentage-sampled markers; hovering previews a turn and clicking scrolls to it.                             |
| 12  | Open a session containing several completed rounds. | Each round's final assistant message shows a visible timestamp and Copy button directly below the message; earlier assistant messages in the same round do not. |

## Edge Cases

| #   | Scenario                             | Steps                                                                        | Expected Result                                                                                               |
| --- | ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | Empty session                        | Session has zero events.                                                     | `ChatHistoryEmptyState` renders; no crash.                                                                    |
| 2   | Single turn                          | Session has exactly one turn.                                                | Renders correctly; pagination controls hidden or disabled.                                                    |
| 3   | Duplicate events from dedup pipeline | Events pipeline returns deduped list.                                        | Each event appears exactly once; no duplicates in DOM.                                                        |
| 4   | Very long session (500+ turns)       | Open session with many turns.                                                | Virtuoso windowing ensures only visible turns are in DOM.                                                     |
| 5   | Rapid new messages                   | 10 messages arrive in quick succession.                                      | All appended; auto-scroll behaves without jump/flicker.                                                       |
| 6   | Active session has todos             | Todo state contains incomplete items.                                        | Composer row shows a todo icon plus completed/total pill; clicking it opens the checklist above the composer. |
| 7   | Group chat mode                      | Session is an agent-org group chat.                                          | `isAgentOrgGroupChatUserMessage` path renders group-specific header.                                          |
| 8   | Paginated page 2 with no turns       | Navigate to page 2 that has 0 visible turns.                                 | Empty state or "no turns on this page" message shown.                                                         |
| 9   | Search query with no results         | Type a unique string that matches nothing.                                   | Empty result state shown in search mode.                                                                      |
| 10  | Revert dialog cancelled              | Open revert dialog; click Cancel.                                            | Dialog closes; no state mutation.                                                                             |
| 11  | Empty injected file section          | Message contains only the file-section title.                                | The heading-only user bubble is omitted.                                                                      |
| 12  | More than 20 conversation turns      | Open a non-paginated conversation with 100 turns.                            | The minimap renders exactly 20 evenly distributed markers including the first and last turns.                 |
| 13  | Narrow chat pane                     | Resize the non-paginated pane below 640px and scroll.                        | A compact floating minimap appears during scrolling, remains briefly for navigation, then clears.             |
| 14  | Two-round conversation               | Open a conversation with two rounds, including a sparse or headerless round. | Two closely spaced minimap handles render and both rounds remain navigable.                                   |
| 15  | Multiple visible rounds              | Scroll until two or more rounds intersect the viewport.                      | Every corresponding sampled minimap handle uses `primary-6`; only one handle exposes `aria-current`.          |
| 16  | Long agent message in an older round | Open a prior round containing an agent message taller than 20 lines.         | The message starts as a 20-line preview with an expand control; the latest round remains fully open.          |
| 17  | Full-screen chat pane                | Expand a non-paginated chat pane beyond 640px.                               | The minimap sits in a transparent, edge-aligned 38px column matching the Workstation trailing strip.          |
| 18  | Minimap hover navigation             | Hover or keyboard-focus a minimap handle.                                    | History appears above the rail; previous/next controls appear below and navigate every real round.            |
| 19  | Non-pagination history list          | Click the minimap History control, then select a round.                      | The virtualized round list opens; selecting a row closes it and naturally scrolls to that round.              |
| 20  | Narrow left-docked chat pane         | Narrow the chat pane below 640px and hover a minimap handle.                 | The preview opens to the handle's right; wide panes and right-docked chats continue opening it to the left.   |

## Error / Degraded States

| #   | Scenario                     | Steps                                                     | Expected Result                                           |
| --- | ---------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| 1   | Session atom rejects         | Session atom throws.                                      | Error boundary catches; fallback UI shown.                |
| 2   | Item renderer throws         | A single `ChatItemRenderer` throws for a malformed event. | Error boundary catches per-item; rest of history renders. |
| 3   | Scroll container zero height | `GroupedVirtuoso` mounted in 0-height container.          | No infinite loop; renders gracefully.                     |

## Accessibility

- [ ] Keyboard-navigable (Tab through turns; Enter to expand/collapse)
- [ ] Screen reader label on list container (announced as "Chat history")
- [ ] Pagination-mode pinned headers do not duplicate focusable controls
- [ ] User bubbles preserve keyboard access to copy/edit/restore controls in both pagination modes
- [ ] Todo pill exposes its expanded state and closes with Escape or an outside click
- [ ] Conversation minimap markers are keyboard-focusable, expose the selected turn with `aria-current`, and show previews on focus
- [ ] Minimap History, previous-round, and next-round controls use labeled native buttons and preserve keyboard focus
- [ ] Final-message Copy buttons are keyboard-focusable and have localized accessible labels
- [ ] Focus trap not applicable (scrollable list, not a modal)

## Acceptance Criteria

- [ ] All turns render in correct chronological order
- [ ] Non-pagination mode uses natural scrolling without pinned turn headers
- [ ] User messages are compact right-aligned bubbles in both pagination modes
- [ ] Todo progress appears once in the composer row and not inside chat-history groups
- [ ] Non-pagination conversations expose a percentage-sampled minimap with no more than 20 markers
- [ ] The minimap History control opens the shared virtualized round list without enabling pagination
- [ ] Auto-scroll follows agent when user is at bottom
- [ ] Collapse-all collapses all tool-call blocks
- [ ] Pagination controls navigate between pages correctly
- [ ] Search highlights matching turns
- [ ] Empty session shows empty state
- [ ] Duplicate events are deduplicated by the pipeline
- [ ] Every completed round exposes one final-message footer with a timestamp and Copy action
- [ ] `pnpm test` passes with no new failures
- [ ] No TypeScript errors (`pnpm typecheck`)
