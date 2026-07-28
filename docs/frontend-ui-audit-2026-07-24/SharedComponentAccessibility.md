# Frontend UI Audit — Shared Component Accessibility

**Files:** `src/components/DateRangeSelector/index.tsx`, `src/components/Image/index.tsx`, `src/components/SearchInput/index.tsx`, `src/components/TrafficLights/index.tsx`, `src/components/Virtualized/VirtualizedSessionList.tsx`
**Date:** 2026-07-24

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `DateRangeSelector/index.tsx:96` | date-range trigger | fixed | A clickable `<div>` duplicated native activation and focus behavior. | Replaced with a native `button` carrying dialog expanded state. |
| `SearchInput/index.tsx:213` | replace-mode chevron | fixed | The clickable wrapper was not keyboard- or screen-reader-operable. | Replaced with a labelled native `button`. |
| `TrafficLights/index.tsx:106-128` | window controls | fixed | Three clickable `<div>` elements reimplemented keyboard activation and disabled behavior. | Replaced with native buttons; maximize uses the native `disabled` contract. |
| `Image/index.tsx:229` | preview close control | keep with reason | The close button uses preview-specific absolute geometry owned by `image-preview-close`; a general Button/IconButton would add incompatible box styling. It remains a native labelled button. | — |
| `VirtualizedSessionList.tsx:54` | virtual session row | keep with reason | The virtualizer expects a block row and measures that node directly. The row now supplies button role, focus, accessible name, and Enter/Space activation without changing the measured element type. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `DateRangeSelector/index.tsx:90-104` | `rounded-[8px]`, `py-[1px]`, `text-[14px]`, `font-[400]` | fixed | Each value has a project spacing/typography equivalent. | Replaced with `rounded-lg`, `py-px`, `text-sm`, and `font-normal`. |
| `TrafficLights/index.tsx:108-126` | 14px circles and 0.5px borders | keep with reason | These optical values reproduce the macOS traffic-light control rather than a general product spacing pattern. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `TrafficLights/index.tsx:108-126` | macOS red/yellow/green hex colors | keep with reason | The colors are platform-native control colors, not product semantic state colors, and are isolated to this dedicated component. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `Image/index.tsx:154-239` | image preview dialog | fixed | The preview now exposes dialog/modal semantics, an accessible name, a labelled close button, and Escape dismissal with listener cleanup. | — |
| `SearchInput/index.tsx:213-227` | expand/collapse control | fixed | The control exposes a translated label and `aria-expanded` state while inheriting native keyboard activation. | — |
| `VirtualizedSessionList.tsx:40-66` | selectable session row | fixed | Rows are focusable, named, and activate through Enter or Space in addition to pointer input. | — |

## D5 — Visual Patterns Observed

- Native button semantics replace local keyboard emulation where the element has ordinary button geometry.
- The virtualized session row is the only changed exception because its measured block node is part of the virtualization contract.
- No new design-system component or repo-wide visual sweep is required.

## Summary

- 7 fixes applied
- 4 patterns kept with documented reason
- 0 remaining abstraction candidates
