# AgentEvolutionPanel UI audit

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `AgentEvolutionPanel.tsx:44` | raw `<div>` placeholder | fix | Hand-rolled `animate-pulse rounded-full bg-fill-3` where `SkeletonBar` exists. | Done — `SkeletonBar`. |
| `AgentEvolutionPanel.tsx:44` | `bg-fill-3` | fix | Token drift, not intent. The placeholder stands in for a `Switch`, but `Switch` styles its track through the SCSS class `.switch-track`, not a Tailwind fill token — so this was never matched to the control's real color. See `GLOBAL.md` D3. | Done — unified on `fill-2`. |
| `AgentEvolutionPanel.tsx:44` | `h-5 w-9 rounded-full` | keep with reason | Reserves the exact footprint of the `Switch` that replaces it, so the settings row does not reflow when `learnings.loaded` flips. | None. |

Verdict totals: **2 fix**, **1 keep with reason**, **0 abstract**.
