# Frontend UI Audit — SessionInfoLine (worktree-source touchpoints)

**Files:**

- `src/features/SessionCreator/components/SessionInfoLine.tsx` (730 LOC)
- `src/features/SessionCreator/components/SessionInfoLine/buildSessionInfoSegments.tsx` (182 LOC)

**Date:** 2026-07-11
**Auditor:** worktree-source-selector broad-scope pass
**Scope note:** `src/features/**` (outside the `design-system-components.mdc` enforced
`modules|engines|scaffold` set). Audited specifically for the worktree-source-selector touchpoints:
the location pill trigger, the modal mount, and the shortcut bridge. This is a **new** report
(the prior batch only covered `WorktreeSourceModal`).

## D1 — Raw HTML vs Design System

| Line                                  | Element                                                       | Verdict              | Reason                                                                                                                                                                                                                                                                     | Suggested change |
| ------------------------------------- | ------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| SessionInfoLine 636-640               | `<PillGroup segments={…} />` (repo / branch / location pills) | keep (good practice) | All three pill triggers — including the location pill that opens `WorktreeSourceModal` — are declared as data (`buildSessionInfoSegments`) and rendered by DS `PillGroup`. **No raw `<button>`/`<input>` anywhere in either file.**                                        | —                |
| SessionInfoLine 699-711               | `RunningLocationDropdownPanel` via `createPortal`             | keep                 | DS panel component; portal to `document.body` is the standard anchored-dropdown pattern used repo-wide.                                                                                                                                                                    | —                |
| SessionInfoLine 714-724               | `<WorktreeSourceModal>` mount                                 | keep                 | Gated behind `worktreeLocation !== undefined && isWorktreeSourceModalOpen`; state is opened only from `handleLocationRowSelect` when the "worktree" row is chosen and `onWorktreeSourceSelect` exists. Clean conditional mount — the modal owns its own DS `Modal` chrome. | —                |
| buildSessionInfoSegments (whole file) | segment factory returning `PillGroupSegment[]`                | keep                 | Pure data builder; emits no JSX interactive elements — only icon nodes + tooltip content passed as props to DS `PillGroup`.                                                                                                                                                | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                         | Value                                                     | Verdict | Reason                                                  | Suggested change |
| ---------------------------- | --------------------------------------------------------- | ------- | ------------------------------------------------------- | ---------------- |
| SessionInfoLine 638          | `className="flex-wrap"`                                   | keep    | Layout utility, no color/size literal.                  | —                |
| buildSessionInfoSegments 110 | `text-text-1` / `text-primary-6` (icon color)             | keep    | Named tokens.                                           | —                |
| —                            | (no `bg-[var(--…)]`, hex, or rgb literals in either file) | —       | Colors come from tokens; icon colors are token classes. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                     | Value                                | Verdict | Reason                                                                                                                                                                                                  | Suggested change |
| ---------------------------------------- | ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| buildSessionInfoSegments 17              | `SESSION_INFO_LABEL_MAX_WIDTH = 180` | keep    | A **numeric JS constant** passed to the `maxLabelWidth` prop — not a Tailwind arbitrary class. Named, single source of truth, reused for all three segments. Correctly a constant, not a magic literal. | —                |
| buildSessionInfoSegments 108,134,158-ish | `size={14}` on lucide icons          | keep    | Icon `size` is a numeric prop, not a `w-[14px]`/`h-[14px]` class; 14px matches the repo's pill-icon convention (`strokeWidth={1.75}`).                                                                  | —                |
| SessionInfoLine 313                      | `useDropdownEngine({ gap: 6 })`      | keep    | Numeric engine config (px gap), not a className literal; matches `DROPDOWN_PANEL.triggerGap` family.                                                                                                    | —                |

## D4 — Accessibility

| Line                                               | Element                                             | Verdict              | Reason                                                                                                                                                                                                                                                                                                  | Suggested change |
| -------------------------------------------------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| buildSessionInfoSegments 117-127, 138-147, 165-176 | Per-segment `ariaLabel` + keyboard-shortcut tooltip | keep (good practice) | Every pill segment (repo / branch / location) carries an `ariaLabel` (`sourceAria`/`branchAria`/`locationAria`) and a `KeyboardShortcutTooltipContent`, and `disabled` is threaded through. The location pill (the worktree-source trigger) is fully named.                                             | —                |
| SessionInfoLine 160-247                            | `useSelectorShortcutBridge`                         | keep                 | Bridges global shortcut atoms (⌘. / ⌥⌘. / ⇧⌘.) to the local repo/branch/location selectors via a Jotai `store.sub` (not a render effect). The location branch respects `disabled` and `worktreeLocation === undefined` gating. Keyboard-openable selectors — a11y positive. Pure wiring, no UI surface. | —                |
| SessionInfoLine 714-724                            | Worktree modal open path                            | keep                 | Opening is keyboard-reachable (location pill is a DS `PillGroup` button + shortcut bridge); the modal itself provides focus trap + Escape via DS `Modal`.                                                                                                                                               | —                |

## D5 — Visual Patterns Observed

- **Pill trigger + anchored dropdown/modal** (repo, branch, location): consistently expressed as
  `buildSessionInfoSegments` → `PillGroup` + a portal panel / modal. This is the canonical local
  pattern and is already DS-routed — no duplication debt.
- No raw-HTML pattern found in either file; nothing to abstract.

## Summary

- **0 fixes** — both files are clean for the worktree-source touchpoints.
- **7 keep (all good-practice / DS-routed):** `PillGroup` triggers, portal panel, gated modal mount,
  pure segment factory, `SESSION_INFO_LABEL_MAX_WIDTH` constant, per-segment `ariaLabel`+tooltip,
  shortcut bridge.
- **0 fix candidates, 0 keep-with-reason, 0 abstract candidates.**

**Good-practice keeps to protect from future re-flagging:**

1. The location pill (worktree-source trigger) is **not** a raw `<button>` — it is a
   `PillGroupSegment` rendered by DS `PillGroup`. Do not "migrate to DS"; it already is.
2. `SESSION_INFO_LABEL_MAX_WIDTH = 180` is a numeric prop constant, **not** a D3 arbitrary Tailwind value.
3. Every segment already has an `ariaLabel` — the a11y debt is entirely inside `WorktreeSourceModal`
   (search input name + error `role="alert"`), not in the trigger layer.
