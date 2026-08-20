# Frontend UI Audit — CanvasRevisionActivity

**Files:** `src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionActivity.tsx`, `src/engines/ChatPanel/rendering/adapters/CanvasInlineAdapter.tsx`
**Date:** 2026-08-06
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                             | Element                   | Verdict          | Reason                                                                                                                          | Suggested change |
| -------------------------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionActivity.tsx:101` | navigable activity header | keep with reason | Reuses the shared `EventBlockHeader` and its tokenized `EventNavigateIcon`; no Canvas-only button or clickable shell was added. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                         | Verdict          | Reason                                                                            | Suggested change |
| ---- | ----------------------------- | ---------------- | --------------------------------------------------------------------------------- | ---------------- |
| —    | No new arbitrary color values | keep with reason | Navigation inherits the existing event-header fill, text, hover, and icon tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                             | Value                | Verdict          | Reason                                                                                                                       | Suggested change |
| -------------------------------- | -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionActivity.tsx:130` | 14px timeline offset | keep with reason | Existing optical alignment centers the progress rail beneath the shared event icon; the navigation change does not alter it. | —                |

## D4 — Accessibility

| Line                             | Element                      | Verdict          | Reason                                                                                                                                                     | Suggested change |
| -------------------------------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionActivity.tsx:101` | shared navigation affordance | keep with reason | Matches the established chat activity contract: the visible shared arrow is a native button, while the full header remains an additional pointer hit area. | —                |

## D5 — Visual Patterns Observed

| Line                              | Element                 | Verdict          | Reason                                                                                                                                          | Suggested change |
| --------------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionActivity.tsx:51`   | event-to-Canvas locate  | keep with reason | Reuses `useBlockHeader` and the session replay pointer used by existing tool activities instead of introducing a second Canvas navigation path. | —                |
| `CanvasRevisionActivity.tsx:115`  | variable activity title | keep with reason | Uses the shared title slot's truncation contract and native hover text, so long Canvas names stay inside narrow chat columns.                   | —                |
| `CanvasInlineAdapter.tsx:110-114` | revision event identity | keep with reason | The adapter forwards the persisted revision event ID, allowing replay and Canvas projection to resolve the corresponding latest logical Canvas. | —                |

- The activity deliberately uses the revision event as the replay anchor. The existing Canvas projection follows `target_event_id` / revision ancestry and materializes the latest valid state of that logical Canvas.
- Records without a stable event ID remain readable but inert, avoiding an ambiguous jump target.

## Summary

- 0 fixes required
- 7 kept with documented reason
- 0 abstract candidates
