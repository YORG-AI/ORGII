# Frontend UI Audit — Chat Natural Scroll and User Bubbles

Scope: chat scrolling, turn-header pinning, and the unified user-message presentation in `ChatHistory`, `ChatHistoryList`, `GroupHeaderRenderer`, and `UserChatItem`.

The repository-referenced `frontend-ui-audit` skill is not installed in either documented location. This report follows the required table convention and manually checks design-system usage, arbitrary Tailwind values, accessibility, responsive behavior, and duplicated visual patterns.

| Line                          | Element                           | Verdict          | Reason                                                                                                                                                                                              | Suggested change |
| ----------------------------- | --------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatHistory/index.tsx:1030`  | Pinned turn header                | keep with reason | The external pinned turn copy is explicitly limited to pagination mode; agent-organization context controls remain independently available.                                                         | None.            |
| `ChatHistoryList.tsx:690`     | Inline header cleanup             | keep with reason | The list clears the visibility and `aria-hidden` values previously written by the pagination pin path, preventing stale hidden headers when pagination is switched off without remounting the list. | None.            |
| `GroupHeaderRenderer.tsx:220` | User-message presentation routing | keep with reason | Pagination, pinned-pagination, and natural-scroll headers all reuse the same user-message component without a parallel full-width presentation branch.                                              | None.            |
| `UserChatItem.tsx:342`        | Right-aligned bubble              | keep with reason | Uses semantic fill tokens for a consistent message surface in both pagination modes, preserves standard spacing, and reserves left-side room for external actions without introducing raw colors.   | None.            |
| `UserChatItem.tsx:351`        | Copy/edit action cluster          | keep with reason | Actions sit outside the bubble on its left without a group surface, slide outward as they appear, and remain available for pointer hover and keyboard focus with the existing labeled controls.     | None.            |
| `ChatBubble/index.tsx:105`    | Unused copy-button `className`    | fix              | No copy-button caller customized this prop, and the unified toolbar no longer needs a presentation escape hatch.                                                                                    | Removed.         |

## Summary

- fix: 1
- keep with reason: 5
- abstract: 0
- sweep candidates: none
