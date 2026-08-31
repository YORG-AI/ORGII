# Dropdown hover grace UI audit

Scope: shared action-menu flyouts, hover-triggered Dropdown, and both submenu levels of WorkItemContextMenu. The user requested easier access to lower submenu options across dropdowns. The change is interaction-only; no typography, colors, dimensions, positioning, or settings copy changed.

| Line                                                                                | Element                             | Verdict          | Reason                                                                                                                                                                                            | Suggested change |
| ----------------------------------------------------------------------------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/components/Dropdown/ActionMenuSurface.tsx:215`                                 | Submenu trigger                     | keep with reason | Uses DropdownItem with menuitem, haspopup, expanded, and keyboard activation semantics. Immediate click/key activation is retained while pointer-only switching gets a short grace period.        | None.            |
| `src/components/Dropdown/ActionMenuSurface.tsx:238`                                 | Fixed flyout and gap padding        | keep with reason | Fixed placement avoids clipping, the existing panel and width tokens remain authoritative, and re-entry cancels dismissal without adding invisible hit targets over neighboring actions.          | None.            |
| `src/components/Dropdown/index.tsx:195`                                             | Shared hover trigger/panel behavior | keep with reason | One shared timer owner handles inline and portaled menus; caller-supplied zero/custom delay and click-open behavior are preserved. No new visual constants or config-level style sweep is needed. | None.            |
| `src/modules/ProjectManager/WorkItems/components/WorkItemContextMenu/index.tsx:318` | Context-menu surfaces and rows      | keep with reason | Existing token-based panel/row styling and native button keyboard behavior stay unchanged. Both nested levels share the same grace/cancellation policy rather than independent leave timers.      | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.

No additional systematic UI sweep was identified. Other inspected click-persistent sidebar, model, and slash-command panels do not close on leaving their panel, so their dismissal policies were not changed. This does not claim every bespoke submenu uses the new sibling-switch delay.

Visual evidence: no screenshots produced. Appearance is unchanged, and desktop UI control requires explicit user opt-in. DOM interaction regressions cover crossing the gap to the third option, adjacent-row traversal, keyboard focus, immediate clicks, and nested portal re-entry; real Tauri hit-testing and pointer feel remain unverified.
