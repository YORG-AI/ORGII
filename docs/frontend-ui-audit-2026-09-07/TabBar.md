# TabBar UI audit

| Line                                                  | Element            | Verdict          | Reason                                                                                                           | Suggested change |
| ----------------------------------------------------- | ------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/WorkStation/shared/TabBar/index.tsx:469` | Drag preview shell | keep with reason | Uses the shared drag surface styling and the regular tab’s 240px width cap; the visual duplicate is aria-hidden. | None.            |
| `src/modules/WorkStation/shared/TabBar/index.tsx:473` | Icon and label     | keep with reason | Uses WorkstationTabContent with the same tab, selection state, and Git status as the strip.                      | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
