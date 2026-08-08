# Frontend UI Audit — TeamInboxAssignmentNotifications

**Files:** `src/components/Message/index.tsx`, `src/modules/MainApp/TeamInbox/TeamInboxView.tsx`, `src/modules/MainApp/TeamInbox/ConnectedTeamInboxView.tsx`
**Date:** 2026-07-30
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `Message:232-270` | Inline toast action and close `<button>` elements | keep with reason | The text-link actions and 24px close hit area are part of the existing isolated toast-root pattern; the design-system `Button` adds container sizing/padding that does not cover these compact roles. All controls remain native buttons. | — |
| `TeamInboxView` | No raw interactive elements added | keep with reason | Notification-driven selection composes the existing `TeamInboxList`, `Placeholder`, and `SplitViewLayout` design-system surfaces. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `Message:206` | Component-owned shadow/padding values | keep with reason | These values predate this feature and define the existing toast elevation and compact inset; the new action reuses that surface without adding another visual recipe. | — |
| `TeamInboxView` | No arbitrary color/token values added | keep with reason | New focus-request behavior is state-only and introduces no styling. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `Message:218-265,294` | Existing 13px toast type, 24px close target, and 380px max width | keep with reason | They are established toast-specific dimensions; this feature does not add or fork them. The new primary action uses the existing text-action scale. | — |
| `TeamInboxView:451-453` | Existing split-view width presets | keep with reason | These are unchanged layout constraints owned by `SplitViewLayout`, not notification-specific styling. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `Message:249-256` | Primary toast action | keep with reason | Native button with a required visible localized label; keyboard activation is automatic. | — |
| `Message:263-270` | Toast close action | keep with reason | Native button retains its localized `aria-label`. | — |
| `TeamInboxView:158-190` | Notification-driven selection | keep with reason | It reuses the listbox/option semantics and existing detail surface; no modal or focus trap is introduced. | — |

## D5 — Visual Patterns Observed

- The feature extends the single shared `Message` toast implementation; it does not create a Team Inbox-specific popup.
- Toast activation and native notification activation converge on the same Team Inbox focus-request state instead of duplicating navigation UI.
- No new cross-file visual pattern reaches the abstraction threshold.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates
