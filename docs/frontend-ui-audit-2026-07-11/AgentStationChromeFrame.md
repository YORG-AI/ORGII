# Frontend UI Audit — AgentStationChromeFrame

**File:** `src/modules/WorkStation/AppShell/AgentStationChromeFrame.tsx` (78 LOC)  
**Companion style:** `src/styles/_utilities.scss` (`.composer-breathing`, `.station-chrome-static-glow`)  
**Date:** 2026-07-11  
**Auditor:** orgii session  
**Skill:** `~/.orgii/skills/frontend-ui-audit/SKILL.md`

## Context

This pass audits the agent-station chrome frame after a glow-animation rework.
The `.tsx` change is a single class rename: the illuminated glow overlay div went
from `composer-breathing` → `station-chrome-static-glow`. The behavioral change
lives in `_utilities.scss`:

- the old `composer-breathe` / `composer-breathe-focused` keyframes animated the
  `box-shadow` directly (expensive: box-shadow is not GPU-composited);
- the rework splits the breathing glow into two stacked pseudo-elements
  (`::before` dim, `::after` bright) that **crossfade via `opacity`** (compositable,
  `will-change: opacity`), and moves the static frame glow into a separate
  `.station-chrome-static-glow` class that this component now applies;
- a `@media (prefers-reduced-motion: reduce)` block disables the animation and
  pins a steady mid-opacity glow.

`AgentStationChromeFrame` renders only `<div>` wrappers — no interactive elements —
so the DS component-routing rule (`src/modules/**`) has no interactive target here.

Existing prior report check: no `docs/frontend-ui-audit-*/AgentStationChromeFrame.md` existed before this run.

## D1 — Raw HTML vs Design System

| Line      | Element                         | Verdict | Reason                                                                                                                                                                                  | Suggested change |
| --------- | ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 28, 54–71 | `<div>` layout/wrapper elements | keep    | Pure non-interactive layout primitives (flex containers, decorative glow overlay). `<div>` wrappers are explicitly allowed; there is no interactive element to route to a DS component. | —                |

**D1 verdict:** clean — no interactive raw HTML.

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                                                                                | Verdict          | Reason                                                                                                                                                                                                                   | Suggested change |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 59   | `bg-[radial-gradient(circle_at_50%_100%,color-mix(in_srgb,var(--color-primary-6)_14%,transparent),transparent_58%)]` | keep with reason | Tailwind has no utility for a radial-gradient with `color-mix`; the value is already built on the project token `--color-primary-6`, not a hardcoded color. This is a one-off decorative glow, not a repeatable surface. | —                |
| 43   | `rounded-[calc(var(--radius-page)-4px)]`                                                                             | keep with reason | Computed concentric-radius (outer `--radius-page` minus the 4px inset). The intent is documented in the in-file comment (lines 36–43). No static token can express "outer radius − inset".                               | —                |
| 51   | `border-[1.5px]`                                                                                                     | keep             | Sub-scale border-width microadjustment (1.5px) for the active-session emphasis; no spacing/border token covers 1.5px.                                                                                                    | —                |

No raw hex / `rgb()` / `hsl()` arbitrary color classes were found — every color
routes through `--color-primary-6` or existing tokens (`border-primary-6/80`,
`ring-primary-6/15`, `border-border-2`, `bg-workstation-bg`).

**D2 verdict:** three arbitrary values, all kept with documented reason (no token
can express radial-gradient / computed-radius / 1.5px border).

## D3 — Hardcoded Sizes / Colors

| Line | Value          | Verdict | Reason                                                                       | Suggested change |
| ---- | -------------- | ------- | ---------------------------------------------------------------------------- | ---------------- |
| 59   | `inset-2`      | keep    | Standard spacing-scale utility (8px), not a pixel literal.                   | —                |
| —    | color literals | keep    | No raw hex / inline `style={{ color }}`; all color via tokens + `color-mix`. | —                |

**D3 verdict:** clean.

## D4 — Accessibility

| Line              | Element                                   | Verdict                 | Reason                                                                                                                                                                                                          | Suggested change |
| ----------------- | ----------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 57–60             | decorative glow `<div>`                   | keep                    | `pointer-events-none`; purely decorative, not announced. No interactive semantics needed.                                                                                                                       | —                |
| `_utilities.scss` | `@media (prefers-reduced-motion: reduce)` | keep (a11y improvement) | The rework **adds** reduced-motion handling: animation is disabled and a steady glow is shown for users who request reduced motion. This is a net a11y gain over the previous unconditional keyframe animation. | —                |

**D4 verdict:** accessible; the reduced-motion media query is a positive a11y
delta introduced by this change.

## D5 — Visual Patterns Observed

| Pattern                                                               | Where seen so far                                                             | Count                | Verdict                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------- |
| Breathing/illuminated chrome glow (opacity-crossfade pseudo-elements) | `AgentStationChromeFrame` + `.composer-breathing` in `_utilities.scss`        | 1 shared style class | keep — the glow is centralized in `_utilities.scss`; the component only toggles it. |
| Concentric inner-radius (`--radius-page` − inset)                     | `AgentStationChromeFrame` (applied 3× within this file for the nested frames) | 1 file               | keep — local nested-frame concern; not yet a cross-file pattern.                    |

## Summary

| Verdict                                     |                                              Count |
| ------------------------------------------- | -------------------------------------------------: |
| Total recommended changes in this file      |                                                  0 |
| Keep with documented reason                 | 3 (radial-gradient, computed radius, 1.5px border) |
| Clean / keep                                |                                                  5 |
| Deferred sweep candidates                   |                                                  0 |
| Abstract candidates introduced by this file |                                                  0 |

**Bottom line:** the `.tsx` change is a cosmetic class rename that pairs with the
`_utilities.scss` glow rework. UI-consistent, no interactive-element debt, and the
animation rework is a performance + a11y improvement (opacity-composited crossfade

- `prefers-reduced-motion` support). No per-file fix required. The scss keyframes
  themselves are out of `*.tsx` D-scope; they are noted here only for the
  performance/reduced-motion context.
