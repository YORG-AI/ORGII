# Frontend UI Audit — AvatarChip

**File:** `src/components/AvatarChip/index.tsx` (102 LOC)  
**Date:** 2026-07-11  
**Auditor:** orgii session  
**Skill:** `~/.orgii/skills/frontend-ui-audit/SKILL.md`

## Context

This pass audits `AvatarChip` after a readability + a11y refactor. The change:

- switched to type-only imports (`MouseEventHandler`, `ReactNode`);
- hoisted every className fragment into module-level constants (`ROOT_CLASS`,
  `BUTTON_CLASS`, `DISPLAY_CLASS`, `SELECTABLE_SELECTED_CLASS`,
  `SELECTABLE_IDLE_CLASS`) plus a local `cx()` joiner and a pure
  `getVisualClassName()` selector;
- added `aria-pressed` for the selectable variant, a `focus-visible` ring, and a
  `disabled`-guarded hover (`!disabled && "hover:bg-fill-2"`) so a disabled chip
  no longer shows a hover affordance.

`AvatarChip` lives **inside** `src/components/` — it is itself a design-system
primitive, so exception #2 in `.cursor/rules/design-system-components.mdc` ("DS
primitives may render native elements internally") applies to its raw `<button>`.

Existing prior report check: no `docs/frontend-ui-audit-*/AvatarChip.md` existed before this run.

## D1 — Raw HTML vs Design System

| Line | Element                              | Verdict          | Reason                                                                                                                                                                                                                                                                                                          | Suggested change |
| ---- | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 84   | `<button>` (interactive chip branch) | keep with reason | `AvatarChip` is a DS primitive in `src/components/`; routing it through DS `Button` would nest a button-in-button and impose `Button`'s own padding/label-wrapping, fighting the avatar + truncating-label chip layout. Native `<button>` keeps keyboard semantics and is the documented DS-internal exception. | —                |
| 96   | `<span>` (static display branch)     | keep             | Non-interactive render path when no `onClick` is supplied; a `<span>` is correct for a read-only chip.                                                                                                                                                                                                          | —                |
| 78   | `<span>` label                       | keep             | Inline text inside the chip; no independent interactive semantics.                                                                                                                                                                                                                                              | —                |

**D1 verdict:** clean. Raw `<button>` is the correct DS-internal primitive element.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                             | Verdict | Reason                                                                                                          | Suggested change |
| ---- | --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| 24   | `focus-visible:ring-primary-6/30` | keep    | Token-based color (`primary-6`) with a standard opacity modifier; not an arbitrary `[var(--...)]` or hex value. | —                |

No `bg-[var(...)]`, raw hex, or `rgb/hsl` arbitrary color classes were found.

**D2 verdict:** clean.

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict                  | Reason                                                                                                                                                | Suggested change                                                           |
| ---- | ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 30   | `py-[2px]` (xs size)    | keep                     | Sub-spacing-scale microadjustment (< 4px); does not belong on the spacing scale.                                                                      | —                                                                          |
| 30   | `text-[11px]` (xs size) | deferred sweep candidate | Known repo-wide typography micro-size debt (see `docs/frontend-ui-audit-2026-06-11/D3-typography-scale-sweep.md`). Not an AvatarChip-specific defect. | Defer to the repo-wide D3 typography sweep; do not land as a one-off edit. |
| 31   | `text-[12px]` (sm size) | deferred sweep candidate | Same repo-wide typography micro-size debt as above.                                                                                                   | Defer to the repo-wide D3 typography sweep.                                |

No raw color literals or inline `style={{ color: "#..." }}` hits were found.

**D3 verdict:** two deferred repo-wide typography candidates; no per-file fix recommended.

## D4 — Accessibility

| Line  | Element                                                          | Verdict | Reason                                                                                                                            | Suggested change |
| ----- | ---------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 84–93 | `<button type="button">`                                         | keep    | Native button → keyboard activation; `type="button"` avoids accidental form submit. Accessible name comes from the `label` child. | —                |
| 87    | `aria-pressed={variant === "selectable" ? selected : undefined}` | keep    | Correctly exposes toggle state for the selectable variant only; the display variant leaves it `undefined` (not a toggle).         | —                |
| 24    | `focus-visible:ring-*` + `focus-visible:outline-none`            | keep    | Adds a visible keyboard-focus indicator without stealing mouse-focus styling — a11y improvement over the pre-refactor state.      | —                |
| 51    | `!disabled && "hover:bg-fill-2"`                                 | keep    | Disabled selectable chips no longer present a misleading hover affordance.                                                        | —                |

**Watch (not a fix):** the accessible name depends entirely on the caller passing a
non-empty `label`. `label: ReactNode` allows a purely-visual node with no text.
This is a caller contract, not an AvatarChip defect — noted so a future consumer
audit can check call sites.

**D4 verdict:** accessible as written; the refactor is a net a11y improvement.

## D5 — Visual Patterns Observed

| Pattern                                                 | Where seen so far                                                                               | Count                                | Verdict                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------ |
| Avatar + truncating label "chip" (display + selectable) | `src/components/AvatarChip/index.tsx`                                                           | 1 component (the abstraction itself) | keep — already the shared primitive. |
| Local `cx()` className joiner                           | `AvatarChip` (this file) vs shared `classNames` in `@src/util/ui/classNames` (used by `Anchor`) | 2                                    | **sweep candidate** — see below.     |

## Summary

| Verdict                                     |                                                   Count |
| ------------------------------------------- | ------------------------------------------------------: |
| Total recommended changes in this file      |                                                       0 |
| Keep with documented reason                 |                              1 (`<button>` chip branch) |
| Clean / keep                                |                                                       6 |
| Deferred sweep candidates                   | 2 (`text-[11px]`, `text-[12px]` typography micro-sizes) |
| Abstract candidates introduced by this file |                                                       0 |

**Sweep candidate (cross-file, do not silently fix):** `AvatarChip` defines a
local `cx()` joiner while the sibling `Anchor` refactor in this same batch imports
the shared `classNames` util (`@src/util/ui/classNames`). Two className-joiner
implementations now coexist. Recommend consolidating `AvatarChip` onto the shared
`classNames` util in a follow-up, rather than patching it inside this PR — flagged
here for the user to decide.

**Bottom line:** `AvatarChip` is UI-consistent and more accessible after the
refactor. No per-file fix required; the only open item is the `cx()` vs shared
`classNames` duplication (sweep candidate) plus the known repo-wide typography
micro-size debt.
