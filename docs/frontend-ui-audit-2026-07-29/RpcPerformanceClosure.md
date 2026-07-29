# Frontend UI Audit — RPC Performance Closure

**Files:** final changed `*.tsx` files in PR #512
**Date:** 2026-07-29
**Auditor:** Codex implementation session

The changed TSX surfaces primarily alter async ownership, cache coordination, diagnostic copy content, and retained browser instances. The audit also compared every visible JSX hunk against `develop`.

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `Projects/index.tsx` grouped list | Existing `VirtualizedGroupedList`, `WorkItemSection`, and `ProjectRow` | fix | The source commit had replaced the established virtualized design-system composition with an unbounded raw `<div>` list. | Restored the `develop` rendering composition while keeping request fencing. |
| Other changed TSX hunks | No new raw interactive element | keep with reason | Changes pass data, diagnostic text, or lifecycle state through existing components and interactions. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Final changed hunks | None added | keep with reason | No new arbitrary CSS-variable, hex, RGB, HSL, or token-bypassing utility is introduced. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Final changed hunks | None added | keep with reason | Browser retention count is a runtime resource bound, not visual geometry; no new pixel or color literal is added to JSX. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| Final changed hunks | Existing controls only | keep with reason | No accessible name, role, keyboard handler, or focus contract is changed. Error diagnostic copying continues through the existing named control. | — |

## D5 — Visual Patterns Observed

- No new visual pattern or shared-component candidate was introduced.
- The only visible-structure drift was the project-list de-virtualization; it was removed.
- Async resource consumers continue to use their existing loading, error, and action surfaces.

## Summary

- 1 fix applied
- 4 findings kept with documented reason
- 0 abstract candidates
