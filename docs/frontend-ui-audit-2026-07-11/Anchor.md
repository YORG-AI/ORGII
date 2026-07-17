# Frontend UI Audit — Anchor

**File:** `src/components/Anchor/index.tsx` (156 LOC)  
**Date:** 2026-07-11  
**Auditor:** orgii session  
**Skill:** `~/.orgii/skills/frontend-ui-audit/SKILL.md`

## Context

This pass audits the current `Anchor` component after the small readability/a11y cleanup. The component is currently used by `TokenManagerContent` as a left-side section navigator for design-token categories.

Existing prior report check: no `docs/frontend-ui-audit-*/Anchor.md` report existed before this run.

## D1 — Raw HTML vs Design System

| Line | Element                            | Verdict          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                        | Suggested change |
| ---- | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 97   | `<button>` anchor row              | keep with reason | This is a navigation-row primitive, not a generic action button. It needs full-row layout, selected-state surface, left truncating label, and right numeric count. The DS `Button` wraps children in its own inner truncating span and applies inline height/padding styles, so replacing this raw button would fight the component API and make the count layout less explicit. Native `<button>` also preserves correct keyboard semantics. | —                |
| 108  | `<span>` label                     | keep             | Inline text inside the named parent button; no separate interactive semantics.                                                                                                                                                                                                                                                                                                                                                                | —                |
| 110  | `<span>` count                     | keep             | Inline numeric metadata inside the named parent button; no separate interactive semantics.                                                                                                                                                                                                                                                                                                                                                    | —                |
| 135  | `<nav>` section-navigation wrapper | keep             | Semantic landmark is appropriate for an in-page/section navigation list.                                                                                                                                                                                                                                                                                                                                                                      | —                |

**D1 verdict:** no fix required. The raw `<button>` is justified for this custom anchor-row layout.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason                                                                                                                      | Suggested change |
| ---- | ----- | ------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep    | No `bg-[var(...)]`, raw hex, rgb/hsl arbitrary color class, or project-owned CSS-var arbitrary value was found in `Anchor`. | —                |

**D2 verdict:** clean.

## D3 — Hardcoded Sizes / Colors

| Line | Value                                           | Verdict                  | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                      | Suggested change                                                                  |
| ---- | ----------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 79   | `text-[10px]` in `ANCHOR_ITEM_COUNT_BASE_CLASS` | deferred sweep candidate | This is a known repo-wide typography debt class rather than an Anchor-specific defect. `docs/frontend-ui-audit-2026-06-11/D3-typography-scale-sweep.md` already records `text-[10px]` as ~100+ sites and recommends consolidation through `TYPOGRAPHY`/a future micro-count token where role-appropriate. This site is bare numeric metadata (`tabular-nums`), not the exact existing `TYPOGRAPHY.badge` shape (`text-[10px] font-medium`). | Defer to the repo-wide D3 typography sweep; do not land as a one-off Anchor edit. |

No raw color literals or inline `style={{ color: "#..." }}` hits were found.

**D3 verdict:** one deferred repo-wide typography candidate; no per-file fix recommended.

## D4 — Accessibility

| Line    | Element                                            | Verdict | Reason                                                                                                                                                       | Suggested change |
| ------- | -------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 97–121  | `<button>` anchor row                              | keep    | Native button gives keyboard activation. It has visible text via `label`, so it has an accessible name. `type="button"` prevents accidental form submission. | —                |
| 99      | `aria-current={isActive ? "location" : undefined}` | keep    | Correctly exposes the active/current section-navigation item to assistive tech.                                                                              | —                |
| 135–138 | `<nav aria-label="Section navigation">`            | keep    | Gives the navigation landmark a useful accessible name.                                                                                                      | —                |
| —       | non-semantic click handlers                        | keep    | No `<div onClick>` / `<span onClick>` pattern was found in this component.                                                                                   | —                |

**D4 verdict:** accessible as currently written.

## D5 — Visual Patterns Observed

| Pattern                                                  | Where seen so far                                                             | Count                          | Verdict                                                                     |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| Left-side section anchor row with label + optional count | `src/components/Anchor/index.tsx`; consumed by `TokenManagerContent`          | 1 component / 1 known consumer | keep — already isolated as a reusable component; no new abstraction needed. |
| Tiny numeric metadata with `text-[10px] tabular-nums`    | Anchor plus multiple unrelated count/timestamp sites surfaced by the D3 sweep | repo-wide                      | deferred to D3 typography sweep; no Anchor-only abstraction.                |

## Summary

| Verdict                                     |                                   Count |
| ------------------------------------------- | --------------------------------------: |
| Total recommended changes in this file      |                                       0 |
| Keep with documented reason                 |               1 (`<button>` anchor row) |
| Clean / keep                                |                                       6 |
| Deferred sweep candidates                   | 1 (`text-[10px]` typography micro-size) |
| Abstract candidates introduced by this file |                                       0 |

**Bottom line:** `Anchor` is UI-consistent after the cleanup. The raw `<button>` should stay because the DS `Button` does not naturally model this custom navigation-row/count layout. The only remaining smell is the known repo-wide `text-[10px]` typography micro-token, which should be handled in the D3 sweep PR rather than patched here.

Total recommended changes: 0. Landing belongs to the D3 typography-scale sweep PR, not this per-file audit.
