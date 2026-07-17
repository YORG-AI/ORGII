# Sidebar edge layering UI audit

Scope: theme-aware macOS sidebar depth at the vertical content boundary and its user-facing Appearance control.

| Line                          | Element                      | Verdict          | Reason                                                                                                                                                    | Suggested change |
| ----------------------------- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `AppearanceSection.tsx:180`   | Sidebar appearance controls  | keep with reason | The macOS-only edge-depth option reuses the shared `SectionRow` and `Switch` components and sits with the related sidebar opacity and selection controls. | None.            |
| `general.ts:144`              | Persisted edge-depth setting | keep with reason | A schema-backed boolean provides validation, migration-safe defaulting, and the same persistence path as adjacent appearance settings.                    | None.            |
| `SidebarBase.tsx:460`         | Sidebar edge rendering       | abstract         | The shared sidebar shell consumes one setting and one semantic theme token, so all sidebar variants react immediately without duplicating styling logic.  | None.            |
| `orgii_main.css:128`          | Light edge token             | keep with reason | The light theme uses a deliberately restrained inset shadow alongside the existing separator.                                                             | None.            |
| `orgii_dark.css:128`          | Dark edge token              | keep with reason | The dark theme increases both separator contrast and depth falloff so the boundary remains perceptible on dark surfaces.                                  | None.            |
| `orgii_high_contrast.css:125` | High-contrast edge token     | keep with reason | High contrast disables the decorative shadow and relies on its stronger existing border.                                                                  | None.            |

## Summary

- Fix: 0
- Keep with reason: 5
- Abstract: 1
- Sweep candidates: 0
