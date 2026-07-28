# Frontend UI Audit — Builder Types

**Files:**

- `src/modules/shared/dataSource/BuilderTypesPanel.tsx`
- `src/modules/shared/dataSource/BuilderTypeDetailPanel.tsx`
- `src/modules/shared/dataSource/BuilderTypeAvatar.tsx`
- `src/modules/shared/dataSource/BuilderProfilePanel.tsx`
- `src/modules/shared/dataSource/index.tsx` (Runtime navigation boundary)

**Date:** 2026-07-28
**Trigger:** full type detail on Profile plus an in-page “Know more” gallery drill-down.

The routed `frontend-ui-audit` skill file was unavailable in both the workspace and user-global locations listed by `AGENTS.md`. This report applies the documented project conventions and the D1–D5 structure used by prior reports in this repository.

## Findings

| Line                                                           | Element                                               | Verdict          | Reason                                                                                                                                                                                                                           | Suggested change |
| -------------------------------------------------------------- | ----------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BuilderTypesPanel.tsx:39`                                     | Gallery portrait card                                 | keep with reason | The card is a semantic non-interactive `article` containing one canonical `Button`. This avoids a nested-button violation while preserving the requested four-line identity hierarchy and explicit “Know more” action.           | None.            |
| `BuilderTypesPanel.tsx:67`                                     | “Know more” action                                    | keep with reason | Uses the same small tertiary design-system `Button` treatment as the Profile header’s Refresh action, with full keyboard behavior and a localized label.                                                                         | None.            |
| `BuilderTypesPanel.tsx:99`                                     | Gallery-first second layer                            | keep with reason | The gallery and four-axis explainer live behind Profile’s “Know more” action, with a labeled Back action. No new Runtime category is introduced.                                                                                 | None.            |
| `BuilderTypesPanel.tsx:108`                                    | Responsive gallery grid                               | keep with reason | Reuses the shared four-column stat-grid token, which collapses to two columns in narrow panel containers.                                                                                                                        | None.            |
| `BuilderTypeDetailPanel.tsx:57`                                | Reusable type detail content                          | keep with reason | Each letter appears once with a semantic two-item bullet list for its behavior and agent guidance. The shared responsive composition is used directly on Profile and when inspecting another gallery type.                       | None.            |
| `BuilderTypeDetailPanel.tsx:125`                               | Gallery type-detail header                            | keep with reason | Inspecting a different gallery type uses a labeled small tertiary Back button and semantic section heading, returning to the gallery without modifying Runtime navigation.                                                       | None.            |
| `BuilderTypeDetailPanel.tsx:66`                                | `@[600px]` and `@[480px]` container-query breakpoints | keep with reason | Runtime can be resized independently of the app window, so container queries are the correct responsive boundary. The values match existing panel patterns and prevent content compression.                                      | None.            |
| `index.tsx:49`                                                 | Stable Runtime tab bar                                | keep with reason | Only durable Runtime categories are registered in the shared `TabPill`; there is no Types tab. The catalog is reached through Profile’s “Know more” action.                                                                      | None.            |
| `BuilderTypesPanel.tsx:97` and `BuilderTypeDetailPanel.tsx:59` | `pb-[50vh]` scroll affordance                         | keep with reason | Matches the self-managed long-panel pattern already used by the adjacent Profile view and keeps the final content clear of the panel edge while scrolling.                                                                       | None.            |
| `BuilderTypeAvatar.tsx:17`                                     | Empty image alternative text                          | keep with reason | Every portrait is immediately paired with its visible type code and name. Treating the illustration as decorative avoids duplicate screen-reader announcements; intrinsic dimensions prevent layout shift.                       | None.            |
| `BuilderProfilePanel.tsx:276`                                  | Profile header actions                                | keep with reason | Refresh and “Know more” share the same small tertiary `Button` treatment. The whole title/action row lives inside Profile’s scroll region, while “Know more” opens the local gallery second layer.                               | None.            |
| `BuilderProfilePanel.tsx:345`                                  | Earned type detail on Profile                         | keep with reason | The full earned-type composition is displayed directly in Profile before measured highlights and evidence, matching the information hierarchy in the supplied reference.                                                         | None.            |
| `BuilderTypesPanel.tsx:92`                                     | Gallery detail state                                  | keep with reason | The selected portrait is component-local state. Back restores the gallery without adding global navigation, retained state, or a separate interaction system.                                                                    | None.            |
| `BuilderProfilePanel.tsx:356`                                  | Profile hero avatar and low-confidence treatment      | keep with reason | The avatar reuses the shared component and is visually muted when the sample is below the existing confidence threshold. The adjacent localized warning communicates the same state without relying on color or filtering alone. | None.            |

## Summary

- Fix candidates: **0**
- Keep with reason: **14**
- Abstract candidates: **0**

No cross-file sweep is warranted: the flow consumes the existing `Button`, `TabPill`, layout tokens, and avatar component without introducing another navigation system.
