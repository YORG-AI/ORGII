# Frontend UI Audit — API Call Panel

**Scope:** `PanelContent.tsx`, `ApiCallDetails.tsx`

|                      Line | Element                       | Verdict          | Reason                                                                                                                                                                                      | Suggested change                                                                    |
| ------------------------: | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
|                     66–87 | Hotspot visibility selectors  | fix              | The previous fixed six-item slices could hide an active polling, timer, or stream group, which makes a diagnostics surface misleading.                                                      | Keep the compact first six entries and append every group classified as actionable. |
|                   123–125 | Call-hotspot transport label  | keep with reason | `HTTP` versus `IPC` is useful diagnostic context and no longer implies multiple application backends.                                                                                       | None.                                                                               |
|                   171–228 | Timer hotspot cards           | keep with reason | These reuse the panel's established card, spacing, color-token, and responsive-grid pattern; a new abstraction would add indirection without a second distinct consumer.                    | None.                                                                               |
|                   239–299 | Event / stream cards          | keep with reason | The card design intentionally matches call and timer hotspots so rates and active states can be compared at a glance.                                                                       | None.                                                                               |
|                   311–430 | API calls table               | fix              | The `Backend` column was redundant and incorrect now that ORGII has one Rust backend.                                                                                                       | Remove the column and give the target column the reclaimed width.                   |
|                    54–137 | Expanded call details         | keep with reason | Conditional Command/Args versus URL rendering is transport-specific content inside one shared detail layout; splitting components would duplicate the surrounding response/source/stack UI. | None.                                                                               |
| 100–143, 174–223, 249–293 | Compact diagnostic typography | keep with reason | The existing 10–12px scale is used consistently throughout this developer-only dense monitoring surface and was not introduced by this change.                                              | Consider a design-token sweep only as a separate panel-wide cleanup.                |

## Verdict summary

- Fix: 2
- Keep with reason: 5
- Abstract: 0

No multi-file design-system sweep candidate was introduced by this change.
