# Frontend UI Audit — Conversation Minimap

Scope: the non-pagination conversation minimap, its turn preview, and the shared static/virtual group navigation path.

The repository-referenced `frontend-ui-audit` skill is not installed in either documented location. This report follows the required table convention and manually checks design-system usage, arbitrary Tailwind values, accessibility, responsive behavior, and duplicated visual patterns.

| Line                          | Element                     | Verdict          | Reason                                                                                                                                                                                   | Suggested change |
| ----------------------------- | --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ConversationMinimap.tsx:13`  | Percentage sampling         | keep with reason | Long conversations retain the first and last turn while distributing the remaining markers across the full history; the fixed cap prevents the rail from growing with transcript length. | None.            |
| `ConversationMinimap.tsx:41`  | User preview normalization  | keep with reason | Reuses the same pill stripping, empty-file-heading normalization, and round-preview truncation as existing chat surfaces instead of introducing a second text-cleanup rule.              | None.            |
| `ConversationMinimap.tsx:49`  | Assistant preview selection | keep with reason | Selects the final assistant message from each already-displayed group, avoiding raw tool events and matching the compact turn-summary intent.                                            | None.            |
| `ConversationMinimap.tsx:274` | Navigation landmark         | keep with reason | Uses a labeled `nav`; every marker is a native button with an accessible turn label, focus ring, tooltip association, and `aria-current` for the visible turn.                           | None.            |
| `ConversationMinimap.tsx:150` | Viewport highlighting       | keep with reason | Multiple viewport-intersecting turns may share the primary visual state, while a single nearest handle retains `aria-current` semantics.                                                 | None.            |
| `ConversationMinimap.tsx:279` | Responsive rail             | keep with reason | The named chat-body container keeps a transparent, edge-aligned 38px rail on wide panes while narrow panes show a handle-width floating surface only during active chat scrolling.       | None.            |
| `ConversationMinimap.tsx:176` | Hover/focus preview         | keep with reason | Reuses the shared dropdown panel surface, anchors it to the hovered or focused marker, and exposes the same preview to keyboard users.                                                   | None.            |
| `ConversationMinimap.tsx:183` | Turn timing summary         | keep with reason | Reuses the turn-collapse sidebar's shared duration and clock-range formatter, and omits the row until measurable timing exists.                                                          | None.            |
| `ChatHistoryList.tsx:593`     | Group navigation handle     | keep with reason | One imperative entry point resolves both static DOM scrolling and virtualized group scrolling, so the minimap does not duplicate list-mode branching.                                    | None.            |
| `ChatHistory/index.tsx:1148`  | Non-pagination placement    | keep with reason | The minimap is explicitly gated out of pagination, page-list, and overview states and lives beside—not inside—the scroll content, preserving natural document flow.                      | None.            |
| `ConversationMinimap.tsx:295` | Hover navigation controls   | keep with reason | Reuses `TabBarTrailingIconButton` for History and adjacent-round controls, so icon sizing, hover, focus, disabled, and tooltip behavior match the Workstation trailing strip.            | None.            |
| `ConversationMinimap.tsx:18`  | Dock-aware preview side     | keep with reason | Uses the containing `ChatView` dock position to open narrow previews toward the pane interior, then resets to the established left-opening placement at the wide-pane breakpoint.        | None.            |
| `TurnPageList.tsx:93`         | Shared virtual history list | keep with reason | Reuses the existing virtualized pagination list and adds optional shared trailing controls only for non-pagination mode; long histories retain bounded DOM and render cost.              | None.            |
| `ChatHistory/index.tsx:706`   | Natural-scroll list select  | keep with reason | Resolves the visible round for list highlighting and routes non-pagination selection through the existing group scroll handle without enabling or mutating pagination.                   | None.            |

## Summary

- fix: 0
- keep with reason: 14
- abstract: 0
- sweep candidates: none
