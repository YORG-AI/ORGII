# Frontend UI Audit — ChatPanelChrome

**File:** `src/engines/ChatPanel/header/ChatPanelChrome.tsx` (95 LOC)
**Date:** 2026-08-21
**Auditor:** Codex PR #850 CI repair

## D1 — Raw HTML vs Design System

No findings. The component delegates interaction to `CollapsedSidebarButton` and renders only layout containers.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value      | Verdict          | Reason                                                                                                                                                                                                    | Suggested change |
| ---- | ---------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 54   | `pr-[7px]` | keep with reason | The exact 7 px trailing alignment is already the established detail/header geometry in `DETAIL_PANEL_TOKENS` and `GitHubPrPanelView`; changing only this shared chrome would create a one-pixel mismatch. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value             | Verdict          | Reason                                                                                                                               | Suggested change |
| ---- | ----------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 48   | computed `height` | keep with reason | The value is selected from named `CHAT_PANEL_*_HEIGHT_PX` layout constants so desktop and remote hosts retain initialization parity. | —                |

## D4 — Accessibility

No findings. The decorative glass layer is explicitly hidden from assistive technology.

## D5 — Visual Patterns Observed

- The tab row and published header are intentionally centralized here for desktop and read-only transcript hosts; no third duplicate remains in the audited scope.

## Summary

- 0 fixes recommended
- 2 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
