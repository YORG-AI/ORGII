# PR tab placement UI audit

Scope: the shared My Station tab bar and its native context menu for moving pull-request tabs to the Chat Panel.

| Line                     | Element                  | Verdict          | Reason                                                                                                                                                  | Suggested change |
| ------------------------ | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TabBar/index.tsx:494`   | Move-action availability | keep with reason | The shared tab bar exposes the action only for losslessly transferable session and PR tabs, keeping domain validation outside the native menu renderer. | None.            |
| `TabContextMenu.tsx:199` | Native move menu item    | keep with reason | The existing `popupNativeMenu` abstraction supplies platform-native menu interaction and accessibility; the shared item is reused for sessions and PRs. | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
