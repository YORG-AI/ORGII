# Frontend UI Audit — Canvas Slash Command

## Scope

- `src/components/ComposerInput/CanvasCommandPillIcon.tsx`
- `src/components/ComposerInput/ComposerPill.tsx`
- `src/engines/ChatPanel/ChatHistory/components/UserMessageContent.tsx`
- `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/index.tsx`

## D1 — Raw HTML / primitive scan

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| — | No raw interactive HTML added | keep with reason | The change renders through the existing `Button`, `BasePill`, and Lucide icon abstractions. | None. |

## D2 — Design-system component usage

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `PinnedActionsBar/index.tsx:285` | Existing `ActionPill` click path | keep with reason | Canvas reuses the same secondary-button action surface and composer insertion path as other pinned actions. | None. |
| `ComposerPill.tsx:350` and `UserMessageContent.tsx:391` | Canvas command pill rendering | keep with reason | Both editable and history surfaces stay inside the existing shared pill containers; only the semantic icon changes. | None. |

## D3 — Token and Tailwind consistency

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `CanvasCommandPillIcon.tsx:10` | Canvas command icon | keep with reason | Size and color come from existing pill tokens; no arbitrary Tailwind values or new visual constants were introduced. | None. |

## D4 — Accessibility basics

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `PinnedActionsBar/index.tsx:285` | Pinned Canvas action | keep with reason | The action remains an existing `Button` with its command name as the title; the icon is decorative within a labeled pill. | None. |

## D5 — Repeated-pattern / abstraction check

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `CanvasCommandPillIcon.tsx:6` | Canvas command detection and icon | keep with reason | A single helper and icon component are reused by composer and history instead of duplicating path matching or SVG styling. | None. |

## Summary

- Fix: 0
- Keep with reason: 6
- Abstract: 0
- Sweep candidates: none
