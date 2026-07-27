# Frontend UI Audit — Organization Tabs

**Scope:** the shared Chat Panel organization tab, cloud/local organization sub-tabs, pinned header, picker, and Sidebar Manage ORG entry point.

The repository-referenced `frontend-ui-audit` skill was unavailable at both documented paths, so this report follows the fallback table convention in `AGENTS.md`.

| Line                                                                        | Element                           | Verdict          | Reason                                                                                                            | Suggested change                                                                                              |
| --------------------------------------------------------------------------- | --------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/components/OrganizationTabSwitch.tsx:13`                               | Organization tab visual contract  | abstract         | Cloud and local views previously selected different TabPill size/color/placement combinations.                    | Route both through the shared simple/default/non-fill TabPill adapter.                                        |
| `src/engines/ChatPanel/panels/OrganizationPanelHeader.tsx:27`               | Shared pinned organization header | abstract         | Provider panels duplicated header placement and cloud alone consumed the additional 40px published-header row.    | Keep controls in one content-level pinned header shared by both variants.                                     |
| `src/engines/ChatPanel/panels/OrganizationPanelHeader.tsx:155`              | Launchpad alignment               | fix              | Organization controls did not match Launchpad's centered 56px, 932px-wide header rhythm.                          | Reuse `DETAIL_PANEL_TOKENS.headerWidth`, `h-14`, centered controls, `gap-3`, `px-4`, and large pills.         |
| `src/engines/ChatPanel/panels/OrganizationPanelHeader.tsx:161`              | Tabs/picker separator             | fix              | Tabs and target selection read as one undifferentiated control group.                                             | Add the Launchpad-style 20px vertical `border-2` separator and hide it from assistive technology.             |
| `src/engines/ChatPanel/panels/OrganizationPanelHeader.tsx:167`              | Organization picker               | fix              | Cloud used a compact filled selector and local management had no equivalent picker.                               | Use the shared large ghost Select with pill radius, cloud/local icons, truncation, and search for long lists. |
| `src/features/Organizations/orgSelectorEntries.ts:47`                       | Picker option formatting          | keep with reason | Personal scope, cloud aliases, and duplicate names need deterministic handling in both sidebar and panel pickers. | Keep one shared entry builder; emit personal once, hide aliases, and qualify duplicate names.                 |
| `src/engines/ChatPanel/panels/CloudOrgPanelView/CloudOrgPanelHeader.tsx:53` | Cloud organization tabs           | fix              | Cloud tabs lived in the separate published 40px bar and used provider-local formatting.                           | Render them through the pinned header and shared organization TabPill adapter.                                |
| `src/engines/ChatPanel/panels/ProjectOrgPanelView.tsx:147`                  | Local organization tabs           | fix              | Local tabs were an inline body block with different size and spacing.                                             | Pin them in the same shared header and keep the hub body in the remaining flex area.                          |
| `src/scaffold/NavigationSidebar/connectors/SidebarOrgSelector.tsx`          | Manage ORG action                 | keep with reason | Management must remain discoverable even when the current scope is personal or no cloud session exists.           | Keep the action always visible and clickable; route to a manageable local/cloud org or Add ORG fallback.      |

## Verdict summary

- Fix: 5
- Keep with reason: 2
- Abstract: 2
- Multi-file sweep candidates: 0

Accessibility check: the picker and tabs remain design-system controls with their existing keyboard/focus behavior; the visual separator uses `role="separator"` and `aria-hidden`; cloud/local options include readable labels rather than icon-only identity; horizontal overflow protects narrow panels without wrapping the tab labels into misaligned rows.
