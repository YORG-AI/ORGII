# Frontend UI Audit — BackgroundLayer / native macOS sidebar

**Files:** `src/modules/shared/components/BackgroundLayer/index.tsx`, `src/modules/index.tsx`, `src/scaffold/NavigationSidebar/SidebarBase.tsx`
**Date:** 2026-07-11
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                            | Element                  | Verdict          | Reason                                                                                                                                                            | Suggested change |
| ------------------------------- | ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BackgroundLayer/index.tsx:112` | Background frame `<div>` | keep with reason | This is a non-interactive clipping/layout layer, not a control or content surface; a design-system component would add semantics and chrome that do not apply.    | —                |
| `BackgroundLayer/index.tsx:122` | Background paint `<div>` | keep with reason | This element is the actual CSS image/color paint target read by the native-background bridge through `data-background-layer`; it must remain a plain DOM surface. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                                                        | Suggested change |
| ---- | ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No arbitrary Tailwind values, raw color literals, or duplicated utility formulas were introduced. Geometry that depends on live sidebar width remains in typed inline styles. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                            | Value                              | Verdict          | Reason                                                                                                                                                                                                                        | Suggested change |
| ------------------------------- | ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BackgroundLayer/index.tsx:94`  | `height: "100vh"`                  | keep with reason | The background frame intentionally covers the native window viewport independently of route content height.                                                                                                                   | —                |
| `BackgroundLayer/index.tsx:112` | Shared `layout-panel-motion` class | keep with reason | Reuses the layout motion duration/easing and reduced-motion rule added for the sidebar, while overriding only `transition-property` to `left`; it also honors the layout-animation setting and disables motion during resize. | —                |
| `BackgroundLayer/index.tsx:126` | Glass opacity `0.5`                | keep with reason | Preserves the existing content-area tint used in glass mode; the tint is now clipped away from the native sidebar rather than visually changed.                                                                               | —                |
| `BackgroundLayer/index.tsx:137` | Blur scale `1.05`                  | keep with reason | Preserves the existing overscan required to prevent transparent edges when the user applies background blur; the new overflow frame clips that overscan before it reaches the sidebar.                                        | —                |

## D4 — Accessibility

| Line                            | Element          | Verdict          | Reason                                                                                                                                                                            | Suggested change |
| ------------------------------- | ---------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `BackgroundLayer/index.tsx:112` | Background frame | keep with reason | The decorative layer is non-interactive and has `pointer-events-none`; it adds no focus target or misleading accessible control. Shared motion respects `prefers-reduced-motion`. | —                |

## D5 — Visual Patterns Observed

- Pattern: docked macOS chrome reveals one native window material, while app wallpaper/color begins at the live sidebar boundary.
- Pattern: background inset motion consumes the same panel-motion class and user preference as the sidebar instead of defining a second animation token.
- Pattern: floating/forced-visible sidebars remain solid for legibility; only the docked macOS sidebar uses the native material.
- No multi-file sweep candidate was found beyond the shared motion token already consumed here.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
