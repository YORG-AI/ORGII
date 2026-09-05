# EventRenderer UI audit

DevTools playground preview surface.

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `EventRenderer.tsx:12` | `EventLoadingFallback` raw `<div>` | fix | Hand-rolled `animate-pulse rounded bg-fill-2` where `SkeletonBar` exists. Lowest-stakes site in the batch (internal DevTools), swept for consistency so the next audit does not re-flag it. | Done — `SkeletonBar`. |

Verdict totals: **1 fix**, **0 keep with reason**, **0 abstract**.
