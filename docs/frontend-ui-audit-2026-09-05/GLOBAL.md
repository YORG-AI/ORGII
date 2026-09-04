# Loading-placeholder sweep — UI audit (whole-repo pass)

Scope: every hand-rolled grey-block loading placeholder in `src/`, found by
sweeping `animate-pulse` and `bg-fill-2` / `bg-fill-3` and classifying each hit
as a **content-shaped placeholder** (in scope) or an **animated indicator**
(out of scope — a different affordance, see D5).

Companion to `fix(loading): replace pulsing skeletons with static skeleton rows`
(PR #1280), which introduced `SkeletonBar` and converted the GitHub detail and
inbox/list surfaces. This pass covers the remainder.

## D1 — Raw HTML vs Design System

Six placeholder sites built a raw `<div className="… animate-pulse rounded
bg-fill-*">` where the `SkeletonBar` primitive now exists. One sweep, not six
findings.

| Site | Verdict | Note |
| --- | --- | --- |
| `src/components/ChatLoadingBlock.tsx:8` | fix | → `SkeletonBar` |
| `src/engines/ChatPanel/blocks/primitives/ChatLoadingBlock.tsx:8` | fix | → `SkeletonBar` |
| `src/engines/ChatPanel/blocks/CanvasInlineCard/index.tsx:63-73` | fix | 5 bars → `SkeletonBar` |
| `src/modules/MainApp/Integrations/Mcp/Table/McpTableParts.tsx:64` | fix | dead export — deleted, not converted |
| `src/modules/MainApp/Integrations/RulesMemoryEvolution/Evolution/AgentEvolutionPanel.tsx:44` | fix | → `SkeletonBar` |
| `src/modules/MainApp/Integrations/DevTools/playground/previews/EventRenderer.tsx:12` | fix | → `SkeletonBar` |

`src/components/Skeleton/index.tsx` is the primitive itself and is `keep with
reason` under D1 by definition — it cannot use itself.

## D2 — Arbitrary Tailwind value vs token

`CanvasInlineCard` keeps `w-[85%]` and `w-[70%]`. **keep with reason:** these
are deliberately ragged line widths so the placeholder does not read as a grid;
Tailwind has no fractional token at 85%, and an arbitrary percentage is the
correct expression of "roughly this much of the line". Concentration is two
values in one file, below the 5-file threshold that would signal a missing
token mapping.

No other arbitrary values were introduced or touched.

## D3 — Hardcoded sizes / colors

No literal hex or rgb anywhere in the swept sites — every fill was already a
token. The finding is **token drift, not hardcoding**: three sites used
`bg-fill-3` and seven used `bg-fill-2` for the same semantic role.

`fill-3` is one step darker than `fill-2` in both themes (`#e3e3e3` vs
`#efefef` light; `#2e2e30` vs `#212121` dark). No evidence the darker value was
deliberate: `AgentEvolutionPanel`'s placeholder stands in for a `Switch`, and
`Switch` styles its track in SCSS (`.switch-track`), so the placeholder was
never matched to a Tailwind token in the first place. Unified on `fill-2`.

Sizes (`h-5 w-9` for the switch placeholder, `h-8` for the chat block, `h-24`
for the canvas chart block) are **keep with reason** — each mirrors the real
control or content box it stands in for, which is the whole point of a
skeleton.

## D4 — Accessibility basics

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `CanvasInlineCard/index.tsx:59` | `aria-label="Loading canvas content"` | fix candidate | Hardcoded English on an `aria-busy` region. Every other loading label in this batch routes through `t()`. | Route through `useTranslation`. **Out of scope here** — it is an i18n change, not a placeholder change. |
| `MarkdownLocalImage.tsx:219`, `ChatImageThumbnail/index.tsx:118` | pulsing image icon | watch | An animated *indicator* (icon heartbeat), not a content-shaped placeholder, so the no-pulse rule does not apply. But the two are character-identical: same icon, size, stroke, and classes. | Confirm with a third occurrence, then extract an `ImageLoadingIcon`. |

`SkeletonBar` sets `aria-hidden` and every consumer keeps its own `aria-busy` /
`role="status"` region, so no placeholder is announced twice.

## D5 — Repeated visual / structural patterns

| Pattern | Count | Verdict | Detail |
| --- | --- | --- | --- |
| Grey-block placeholder | 6 (was 9 before PR #1280) | abstract → **done** | Seam is `SkeletonBar`; this sweep lands it. |
| `ChatLoadingBlock` duplicated per width | 2 | watch | `src/components/ChatLoadingBlock.tsx` (900px) and `src/engines/ChatPanel/blocks/primitives/ChatLoadingBlock.tsx` (800px) are identical but for the width token. Below the 3+ threshold, and the split is *deliberate* — `detailPanelTokens.ts:75` documents the narrower chat measure as a prose-readability choice, not an accident. What would confirm: a third variant appearing (`ISSUE_PANEL_WIDTH_TOKENS` already exists with no block). Then merge into one component taking a width token — ~12 import sites. |
| Animated activity indicators | ~20 | keep with reason | Streaming dots, CI-pending heartbeats, spinners. A spinner answers "is anything happening"; a skeleton answers "what shape is arriving". Different affordances — forcing one API would make both worse. Explicitly *not* swept: `PrCiStatusIndicator.tsx:44`, `StatusDot`, `McpProgressRow`, `ChatFloatingComposer`, `A2UIRenderer`, `CanvasTabHeader`, `canvasPreview`, `AgentBubble`, `ChangedFilesList`, `TeamInboxSessionDropSurface`, `APICallPanel`, `ProgressBar`. |

## Summary

Verdict totals: **7 fix**, **6 keep with reason**, **1 abstract (landed)**,
**2 watch**.

All 7 fixes are in this PR. One of them is a deletion: `McpTableSkeleton` was
exported from `McpTableParts.tsx` and imported by nobody — converting dead code
would have been worse than removing it.

## Recommended order of attack

1. **Landed here.** The six placeholder conversions plus the dead-export
   deletion.
2. **Next, cheap and isolated.** i18n the `CanvasInlineCard` `aria-label`
   (D4) — one line, one `useTranslation` already imported nearby.
3. **Only when a third case appears.** The `ChatLoadingBlock` merge (D5). Two
   deliberate variants do not justify churning 12 import sites.
4. **Not planned.** The animated-indicator family. Documented above as
   `keep with reason` so the next audit pass does not re-flag it.
