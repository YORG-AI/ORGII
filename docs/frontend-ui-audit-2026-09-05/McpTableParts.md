# McpTableParts UI audit

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `McpTableParts.tsx:64` (before) | `McpTableSkeleton` | fix | **Dead code.** Exported, and the identifier appears nowhere else in `src/` — both importers (`McpTable.tsx:46`, `AgentMcpSection.tsx:39`) pull other members from this module. Converting it to `SkeletonBar` would have preserved unreachable UI. | Done — deleted, along with its now-orphaned `SKELETON_ROW_COUNT` constant and the empty `── Constants ──` banner. Module doc header updated. |
| `McpTableParts.tsx:79` | `StatusChip` | keep with reason | Out of scope: not a loading placeholder. | None. |

Note for reviewers: `McpTable` has no loading placeholder at all now. That is
the pre-existing behavior — the dead component was never rendered — and giving
the table one is a feature, not part of this sweep.

Verdict totals: **1 fix**, **1 keep with reason**, **0 abstract**.
