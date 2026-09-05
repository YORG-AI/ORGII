# CanvasInlineCard UI audit

`CanvasLoadingSkeleton` — the placeholder shown while a canvas artifact loads.

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `index.tsx:63-73` | five raw `<div>` placeholder bars | fix | Hand-rolled `animate-pulse rounded bg-fill-3` where `SkeletonBar` exists. | Done — five `SkeletonBar`s. |
| `index.tsx:63-73` | `bg-fill-3` | fix | Token drift: this surface used `fill-3` while seven other placeholders used `fill-2` for the same role, and nothing here matches `fill-3` deliberately. See `GLOBAL.md` D3. | Done — unified on `fill-2`. Visibly one step lighter; flagged in the PR's `Potential risks` because it could not be screenshotted. |
| `index.tsx:68-69` | `w-[85%]`, `w-[70%]` | keep with reason | Deliberately ragged line widths so the block does not read as a grid. No fractional Tailwind token at 85%; an arbitrary percentage is the correct expression. Two values in one file is well below the 5-file concentration threshold. | None. |
| `index.tsx:73` | `h-24` chart block | keep with reason | Mirrors the height of the chart/table the canvas is about to render. | None. |
| `index.tsx:59` | `aria-label="Loading canvas content"` | fix candidate | Hardcoded English on the `aria-busy` region. Every other loading label in this batch routes through `t()`, and this file already imports `useTranslation`. | Route through `t()`. **Deliberately not done here** — an i18n fix is a different responsibility from a placeholder sweep and would need a new translation key across 14 locales. |
| `index.tsx:196` | `animate-pulse bg-primary-6/40` progress underline | keep with reason | An animated *activity* indicator for a streaming canvas, not a content placeholder. The no-pulse rule is scoped to placeholders. See `GLOBAL.md` D5. | None. |

Verdict totals: **2 fix**, **4 keep with reason**, **0 abstract**, **1 fix candidate deferred**.
