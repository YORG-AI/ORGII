# Frontend UI Audit — Uncommitted UI Batch

**Files:** changed `*.tsx` files under `src/components`, `src/engines`, `src/features`, `src/modules`, and `src/scaffold`; detailed Team Inbox, GitHub Star, and shared-component reports are cross-referenced in the 2026-07-22 and 2026-07-23 audit folders.
**Date:** 2026-07-27
**Auditor:** ORGII implementation session

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `TeamInboxRow.tsx` changed row | Semantic listbox option button | keep with reason | The full-row option owns roving focus, selection state, and multi-line content not modeled by the generic Button. | — |
| `GitHubStarReminder.tsx` and `GitHubStarSettingsRow.tsx` changed actions | Shared `Modal` and `Button` controls | keep with reason | Both entry points use established modal, button, section-row, busy, and live-region contracts. | — |
| Shared component ownership batch | Placeholder, search/sort, list-panel, and folder header | fixed | Duplicate module-owned implementations were replaced by canonical components plus compatibility re-exports. | Keep the boundary check in CI/tooling. |
| `CanvasPreviewSurface.tsx` changed rendering boundary | Shadow DOM static-content host | keep with reason | This is a sandboxed content surface rather than an interactive design-system control; DOMPurify and CSS containment own the boundary. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Changed Team Inbox and GitHub Star surfaces | Semantic color and spacing classes | keep with reason | Detailed component reports confirm token use and document compact optical exceptions. | — |
| Shared components | No new raw CSS-variable, hex, RGB, or HSL utility | keep with reason | Relocated primitives preserve project Tailwind tokens. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `FolderHeaderRow.tsx` compact badge | `h-[16px] min-w-[16px]` | fixed | Exact spacing-scale tokens exist. | Replaced by `h-4 min-w-4`. |
| Team Inbox detail/list geometry | Local 320/240/420 split and duplicated panel spacing | fixed | Existing Inbox and detail-panel tokens already define the pattern. | Uses shared split/detail tokens. |
| Compact icon sites | 11px/14px optical icon sizes | keep with reason | These match the existing compact row/header grid and are documented in component-specific reports. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Team Inbox filters and header actions | Tabs and icon-only actions | fixed | Shared `TabPill`, `PanelRefreshButton`, and header action tokens now own semantics and labels. | — |
| Team Inbox list | Listbox/options | keep with reason | Accessible name, active descendant, roving focus, selected state, and Arrow/Home/End navigation are explicit. | — |
| GitHub Star status | Polite live region and busy state | keep with reason | Async fallback, success, and busy transitions are announced without replacing visible labels. | — |
| Static HTML Canvas | Sanitized, non-interactive authored content | fixed | Inline styles are forbidden and boundary-crossing authored styles are rejected before Shadow DOM insertion. | Keep sanitizer regression cases. |

## D5 — Visual Patterns Observed

- Team Inbox consumes existing list-panel, split-view, detail-panel, card, footer, and tab-pill patterns.
- GitHub Star consumes the established settings-row and modal patterns.
- Shared placeholder, search/sort, list-panel, and folder-header ownership is centralized; the new component-boundary check reports no new violations.
- No new repository-wide visual abstraction candidate remains in the audited diff.

## Summary

- 8 fixes confirmed across the component-specific and current sweep reports
- 8 findings kept with documented reason
- 0 remaining abstraction candidates
- Component-boundary check passed with no new violations; 16 tracked legacy violations remain
