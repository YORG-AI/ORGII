# Frontend UI Audit — Builder Types

**Files:**

- `src/modules/shared/dataSource/BuilderTypesPanel.tsx`
- `src/modules/shared/dataSource/BuilderTypeDetailPanel.tsx`
- `src/modules/shared/dataSource/BuilderTypeAvatar.tsx`
- `src/modules/shared/dataSource/BuilderProfilePanel.tsx`
- `src/modules/shared/dataSource/index.tsx` (Runtime navigation boundary)

**Date:** 2026-07-28
**Trigger:** full type detail on Profile plus a gallery with modal type browsing.

The routed `frontend-ui-audit` skill file was unavailable in both the workspace and user-global locations listed by `AGENTS.md`. This report applies the documented project conventions and the D1–D5 structure used by prior reports in this repository.

## Findings

| Line                                  | Element                                               | Verdict          | Reason                                                                                                                                                                                                                              | Suggested change |
| ------------------------------------- | ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BuilderTypesPanel.tsx:45`            | Gallery portrait card                                 | keep with reason | The whole card is one semantic `button`, so the large image and its labels form a single keyboard-accessible target without a nested or repeated “Know more” control.                                                               | None.            |
| `BuilderTypesPanel.tsx:52`            | Larger gallery illustration                           | keep with reason | The transparent portrait is centered at 128px while the code, archetype name, and two preference-label rows remain visible underneath.                                                                                              | None.            |
| `BuilderTypesPanel.tsx:104`           | Gallery Back action                                   | keep with reason | Reuses `PANEL_HEADER_TOKENS.actionButton`, which supplies the standard tertiary, icon-only, circular header treatment. A localized title and `aria-label` retain an accessible name.                                                | None.            |
| `BuilderTypesPanel.tsx:133`           | Responsive gallery grid                               | keep with reason | Reuses the shared four-column stat-grid token, which collapses to two columns in narrow panel containers.                                                                                                                           | None.            |
| `BuilderTypeDetailPanel.tsx:58`       | Reusable type detail content                          | keep with reason | Each letter appears once with a semantic two-item bullet list for its behavior and agent guidance. The shared responsive composition is used directly on Profile and inside the type modal.                                         | None.            |
| `BuilderTypeDetailPanel.tsx:129`      | Type-detail modal                                     | keep with reason | Reuses the shared modal system for focus trapping, Escape/backdrop close behavior, focus restoration, overlay layering, and the canonical tertiary icon-only close action.                                                          | None.            |
| `BuilderTypeDetailPanel.tsx:140`      | Previous / next actions                               | keep with reason | Both navigation controls reuse the shared tertiary icon-only header token and expose localized tooltip and accessible labels. Their placement brackets the current image-and-label content.                                         | None.            |
| `BuilderTypeDetailPanel.tsx:64`       | `@[600px]` and `@[480px]` container-query breakpoints | keep with reason | Runtime can be resized independently of the app window, so container queries are the correct responsive boundary. The values match existing panel patterns and prevent content compression.                                         | None.            |
| `index.tsx:49`                        | Stable Runtime tab bar                                | keep with reason | Only durable Runtime categories are registered in the shared `TabPill`; there is no Types tab. The catalog is reached through Profile’s “Know more” action.                                                                         | None.            |
| `BuilderTypesPanel.tsx:122`           | `pb-[50vh]` scroll affordance                         | keep with reason | Matches the self-managed long-panel pattern already used by the adjacent Profile view and keeps the final content clear of the panel edge while scrolling.                                                                          | None.            |
| `BuilderTypeAvatar.tsx:17`            | Decorative transparent illustration                   | keep with reason | Every portrait is paired with its visible type code and name, so empty alternative text avoids duplicate announcements. `object-contain` preserves the full transparent illustration and intrinsic dimensions prevent layout shift. | None.            |
| `BuilderProfilePanel.tsx:265`         | Profile header actions                                | keep with reason | Refresh and “Know more” retain their useful localized text and share the requested small tertiary `Button` treatment. “Know more” opens the local gallery second layer.                                                             | None.            |
| `BuilderProfilePanel.tsx:356`         | Earned type detail on Profile                         | keep with reason | The full earned-type composition is displayed directly in Profile before measured highlights and evidence, matching the information hierarchy in the supplied reference.                                                            | None.            |
| `BuilderTypesPanel.tsx:82` and `:176` | Local modal selection state                           | keep with reason | The selected portrait remains component-local while the gallery stays mounted beneath the modal. Previous and next wrap through all 16 definitions without adding global navigation or retained state.                              | None.            |

## Summary

- Fix candidates: **0**
- Keep with reason: **14**
- Abstract candidates: **0**

No cross-file sweep is warranted: the flow consumes the existing `Button`, `Modal`, `TabPill`, layout tokens, and avatar component without introducing another navigation system.
