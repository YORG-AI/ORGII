# Frontend UI Audit — Chat Pane Tab Content Renderers

**Date:** 2026-07-19

**Scope:** the new/changed chat-pane content-dispatch components — `TabContent/UnifiedChatPanelTabContent.tsx`, `TabContent/surfaceRenderers.tsx`, `TabContent/UnknownChatPanelTabPlaceholder.tsx`, and the simplified `ChatPanelContent.tsx` / `ChatPanelShell.tsx`.

**Method:** Manual application of the repository's frontend UI audit dimensions; the routed `frontend-ui-audit` SKILL file was not present at the user-global path (only a workspace `architecture-audit` copy exists), so the D1–D5 dimensions are applied as documented in prior reports (e.g. `frontend-ui-audit-2026-07-19/CloudOrgMySessions.md`).

## D1 — Raw HTML vs Design System

| Line / area                          | Element            | Verdict          | Reason                                                                                                                                                                          | Suggested change |
| ------------------------------------ | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `surfaceRenderers.tsx`               | 6 surface wrappers | keep with reason | Each is a thin adapter that renders an existing design-system panel (`WorkItemPanelView`, `ProjectPanelView`, …) with the tab payload as its prop; no new chrome is introduced. | —                |
| `UnknownChatPanelTabPlaceholder.tsx` | error placeholder  | keep with reason | Reuses the shared `Placeholder` block and the existing `placeholders.unknownTabType` key, mirroring WorkStation's `UnknownTabPlaceholder` verbatim.                             | —                |
| `UnifiedChatPanelTabContent.tsx`     | layout `div`s      | keep with reason | The wrapper `div`s reproduce the exact keep-alive layering `ChatPanelShell` used before (display toggling for chat-column/terminal/Kanban); no raw controls added.              | —                |

## D2 — Arbitrary Tailwind Values vs Tokens

| Line / area       | Element     | Verdict | Reason                                                                                                                                                                                                   | Suggested change |
| ----------------- | ----------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| All changed files | class names | keep    | Only utility classes already used by the code being extracted are present (`min-h-0 w-full flex-1 flex-col overflow-hidden`); no arbitrary bracket values, raw colors, or magic spacing were introduced. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / area       | Element          | Verdict | Reason                                                                                                                                                                              | Suggested change |
| ----------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| All changed files | visual constants | keep    | The change is content-dispatch wiring; it introduces no sizes, colors, or z-index values. `display: none/flex/contents` toggling is carried over unchanged from the previous shell. | —                |

## D4 — Accessibility

| Line / area                          | Element                                   | Verdict          | Reason                                                                                                                                                                                                      | Suggested change |
| ------------------------------------ | ----------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `UnifiedChatPanelTabContent.tsx`     | keep-alive terminals & hidden chat-column | keep with reason | Inactive surfaces use `display:none`, removing them from the accessibility tree and tab order while preserving their mounted state — identical to the prior behavior.                                       | —                |
| `UnknownChatPanelTabPlaceholder.tsx` | error state                               | keep with reason | Delegates to the shared `Placeholder` (`variant="error"`, `fillParentHeight`), inheriting its role/labeling; a genuinely unmapped tab is now a visible, announced state instead of a silent Launchpad swap. | —                |
| `surfaceRenderers.tsx`               | `Suspense fallback={null}`                | keep with reason | Matches the pre-existing `ChatPanelContent` lazy-loading pattern for these same panels; no new focus traps or live regions are added.                                                                       | —                |

## D5 — Visual Patterns Observed

| Pattern                                                                                                            | Verdict          | Reason                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One dispatcher owning three keep-alive layers (chat-column / Kanban / terminals) plus dedicated surface components | keep with reason | Consolidates what were two separate mechanisms (`ChatPanelShell` type-switch + `ChatPanelContent` boolean cascade) into a single registry-keyed dispatcher, matching the WorkStation `UnifiedTabContent` pattern. |
| Thin per-type renderer wrappers reading `tab` payload                                                              | keep with reason | Mirrors WorkStation's `TabContent/renderers/*` (`tab.data` → props adapters); keeps the panels themselves prop-driven and unchanged.                                                                              |
| Explicit unknown-type placeholder                                                                                  | keep with reason | Removes the silent Launchpad fallback; an unmapped surface is now diagnosable, matching the design-system's error-placeholder convention.                                                                         |

## Summary

| Verdict                     | Count |
| --------------------------- | ----: |
| fix recommended             |     0 |
| keep with documented reason |     9 |
| keep                        |     2 |
| abstract candidate          |     0 |

No design-system, token, accessibility, or visual-pattern regressions were found. The renderers reuse existing panels and the shared `Placeholder`; no multi-file sweep candidates. The one behavioral UI change — an explicit placeholder replacing the silent Launchpad fallback for unmapped tabs — is an accessibility and diagnosability improvement. Runtime confirmation in the running app remains the outstanding verification step.
