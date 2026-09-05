# ChatLoadingBlock UI audit

Two components, same name, different width tokens.

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/components/ChatLoadingBlock.tsx:8` | raw `<div>` placeholder | fix | Hand-rolled `animate-pulse rounded bg-fill-2` where `SkeletonBar` exists. | Done — renders `SkeletonBar`. |
| `src/engines/ChatPanel/blocks/primitives/ChatLoadingBlock.tsx:8` | raw `<div>` placeholder | fix | Same. | Done — renders `SkeletonBar`. |
| both files | two near-identical components | watch | Identical but for `DETAIL_PANEL_WIDTH_TOKENS` (900px) vs `CHAT_PANEL_WIDTH_TOKENS` (800px). The split is documented and deliberate (`detailPanelTokens.ts:75` — the narrower measure keeps prose lines readable), not copy-paste drift, and 2 occurrences is below the 3+ abstract threshold. | Merge into one component taking a width token **only** once a third variant appears (`ISSUE_PANEL_WIDTH_TOKENS` already exists unused by a block). Costs ~12 import-site edits. |
| both files | `h-8` | keep with reason | Mirrors the height of the chat row it stands in for. | None. |
| both files | element changed `<div>` → `<span>` | keep with reason | `SkeletonBar` is a `span` so it is valid inside phrasing containers. Both blocks sit in block context, where `display:block` on a span is equivalent. Both suites updated to match. | None. |

Verdict totals: **2 fix**, **3 keep with reason**, **0 abstract**, **1 watch**.
