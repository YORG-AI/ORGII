# Frontend UI Audit — Chat Panel Station Availability

**Files:** `src/engines/ChatPanel/ChatPanelHeader.tsx`, `src/engines/ChatPanel/index.tsx`, `src/modules/index.tsx`, `src/modules/shared/layouts/AppLayout.tsx`, `src/modules/WorkStation/shared/TabBar/components/TabLabelRowScrim/index.tsx`
**Date:** 2026-08-08
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                          | Element                            | Verdict          | Reason                                                                                                                                       | Suggested change |
| ----------------------------- | ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelHeader.tsx:257–272` | Station toggle wrapper and control | keep with reason | The wrapper only owns inline layout; the interactive control continues to use the shared `TabBarTrailingIconButton` and `Button` primitives. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                               | Value                            | Verdict          | Reason                                                                                                                   | Suggested change |
| ---------------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `ChatPanelHeader.tsx:252–257`      | Existing tab-bar toolbar spacing | keep with reason | The change reuses the established header height and spacing classes and introduces no arbitrary Tailwind values.         | —                |
| `TabLabelRowScrim/index.tsx:13–15` | Hover fade timing                | keep with reason | The scrim uses the tab surface's existing `duration-150` transition timing, avoiding a one-off duration or easing value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                            | Value                        | Verdict          | Reason                                                                                                                                                | Suggested change |
| ------------------------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelHeader.tsx:266–270`   | Station/maximize icons       | keep with reason | Both icons continue to consume the shared `HEADER_ICON_SIZE.md` token and inherit the design-system button color states.                              | —                |
| `TabLabelRowScrim/index.tsx:13` | Close-control scrim gradient | keep with reason | The fade continues to use the established `fill-2` surface token and transparent edge; only its mount/opacity lifecycle changes.                      | —                |
| `chatPanelTabsModel.ts:130`     | Wide Station breakpoint      | keep with reason | The `1920px` product breakpoint is exposed as one named constant and consumed by the shared availability resolver, not repeated in component classes. | —                |

## D4 — Accessibility

| Line                          | Element        | Verdict | Reason                                                                                                                               | Suggested change                                                                                             |
| ----------------------------- | -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `ChatPanelHeader.tsx:258–264` | Station toggle | fix     | A full-screen-only tab must expose the control as genuinely unavailable, and must not advertise a keyboard shortcut that cannot run. | Pass native `disabled`, remove the click handler, and omit the shortcut while Station access is unavailable. |

## D5 — Visual Patterns Observed

- Pattern: every Chat Panel tab keeps the trailing layout control in the same header position, avoiding tab-dependent toolbar shifts.
- Pattern: disabled Station access uses the shared button's native disabled treatment rather than adding a one-off color or opacity class.
- Pattern: full-screen ownership is derived from the active tab capability; the header and workbench layout consume the same decision.
- Pattern: standalone tabs unlock Station splitting only at the shared `1920px` wide-desktop threshold; conversation tabs keep their existing behavior.
- Pattern: one parent viewport subscription feeds AppShell, AppLayout, and ChatPanel instead of adding parallel resize listeners; resize bursts are coalesced to one update per animation frame and pending work is canceled on unmount.
- Pattern: narrow-layout focus owns one `ResizeObserver`; at idle it observes only the stable main-content width and adds the animated workbench target only during a direct divider drag.
- Pattern: tab and close-control hover layers now share the same transition duration, preventing the scrim from flashing ahead of the tab surface.

## Summary

- 1 fix applied
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
