# Frontend UI Audit — Session Sidebar Reveal

**Date:** 2026-07-14

**Scope:** Session Blame navigation intent, workstation sidebar hydration/group reveal, generic navigation-menu row targeting, and scroll-container ownership.

**Method:** Manual application of the repository's frontend UI audit dimensions because the routed global `frontend-ui-audit` skill file was unavailable in this workspace.

## D1 — Raw HTML vs Design System

| Line / area                            | Element                                                                | Verdict          | Reason                                                                                                                                                                                         | Suggested change |
| -------------------------------------- | ---------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TimelineContent.tsx:305-351`          | Existing root/participant `<button>` rows                              | keep with reason | This change only adds a navigation intent to the existing semantic buttons; it does not introduce a new control or duplicate design-system chrome.                                             | —                |
| `NavigationSidebar.tsx` section header | Existing collapsible `<div>` containing optional nested action buttons | keep with reason | A native outer `<button>` would create invalid nested buttons. The row now has button role, focusability, keyboard activation, and expanded state while preserving the nested action controls. | —                |
| `SidebarList.tsx` scroll container     | Layout `<div>` with optional ref                                       | keep             | Non-interactive layout/scroll ownership; no design-system control applies.                                                                                                                     | —                |

## D2 — Arbitrary Tailwind Values vs Tokens

| Line / area          | Element     | Verdict | Reason                                                                                                                             | Suggested change |
| -------------------- | ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| All changed UI files | Class names | keep    | The feature adds no arbitrary Tailwind values, raw colors, or new spacing rules. Existing sidebar tokens/classes remain unchanged. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / area          | Element             | Verdict | Reason                                                                     | Suggested change |
| -------------------- | ------------------- | ------- | -------------------------------------------------------------------------- | ---------------- |
| All changed UI files | Visual sizing/color | keep    | Reveal behavior is state/DOM navigation only and adds no visual constants. | —                |

## D4 — Accessibility

| Line / area                            | Element                                                  | Verdict          | Reason                                                                                                                                                                             | Suggested change |
| -------------------------------------- | -------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `NavigationSidebar.tsx` section toggle | `role`, `tabIndex`, `aria-expanded`, Enter/Space handler | keep             | The section can now be expanded/collapsed by keyboard and exposes its state without invalid nested-button markup. Nested header actions are excluded from the parent key handler.  | —                |
| `NavigationMenuRow.tsx` rows           | `data-menu-item-id`, `data-selected`                     | keep with reason | These attributes are stable machine-readable navigation/test state and do not replace the existing semantic/selected styling.                                                      | —                |
| `NavigationSidebar.tsx` reveal effect  | `scrollIntoView({ block: "nearest" })`                   | keep with reason | It makes the selected historical row visible without moving keyboard focus or forcing a large centered scroll. A monotonic request ID prevents repeat renders from snapping again. | —                |

## D5 — Visual Patterns Observed

| Pattern                                  | Verdict          | Reason                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-surface “reveal menu row” behavior | keep with reason | The generic sidebar owns scoped one-shot scrolling; the workstation connector hydrates both the root and child targets and owns filters, section collapse, subagent expansion, and stale-intent cleanup. This avoids embedding workstation rules in Session Blame or duplicating scroll logic at each caller. |

## Summary

| Verdict                     | Count |
| --------------------------- | ----: |
| fix recommended             |     0 |
| keep with documented reason |     6 |
| keep                        |     3 |
| abstract candidate          |     0 |

No design-system, token, or visual-consistency regressions were found. The only accessibility-sensitive touched control—the collapsible section header—now has explicit keyboard and expanded-state semantics.
