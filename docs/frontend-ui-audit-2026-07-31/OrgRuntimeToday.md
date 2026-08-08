# Organization-aware Runtime — frontend UI audit

Scope: Runtime's organization selector/tab header, scope-specific navigation,
Today summary, per-person filter, source breakdown, latest shared sessions,
system pulse, and Member breakdown surface.

The repository-referenced `frontend-ui-audit` skill file is unavailable at both
documented paths. This report follows the repository's required table format
and existing Runtime audit precedent.

| Line                                                                | Element                                  | Verdict          | Reason                                                                                                                                                                                              | Suggested change                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `OrganizationScopeHeader.tsx:20-65`                                 | Shared selector/separator/tabs header    | abstract         | Runtime must visibly match Manage Org, and duplicating the complete header classes would make the two surfaces drift.                                                                               | Extract the controlled layout and selector presentation; keep navigation behavior in each owning feature.            |
| `index.tsx:67-130`                                                  | Scope-specific Runtime tabs              | fix              | A single tab bar mixed Personal tools with organization analytics and hid organization ownership behind “Team.”                                                                                     | Personal shows its local Runtime tabs; a cloud org shows Today and Member breakdown through `OrganizationTabSwitch`. |
| `index.tsx:163-243`                                                 | Runtime scope selector                   | fix              | Organization choice belongs beside the tabs, not in the content of one tab.                                                                                                                         | Use the shared pinned selector-and-tabs header with namespaced cloud values and Personal as the local scope.         |
| `TeamRuntimeToday.tsx:48-66`                                        | Today metric cards                       | fix              | The organization view needs the same compact KPI hierarchy as Runtime Usage.                                                                                                                        | Use established borders/background tokens, 12px labels, and 20px emphasized values.                                  |
| `TeamRuntimeToday.tsx:149-182`                                      | Unified Today title row                  | fix              | A standalone refresh row and redundant label/icon added noise around the selected member scope.                                                                                                     | Keep plain Today text, the member dropdown, and Refresh in one responsive title row.                                 |
| `TeamRuntimeToday.tsx:184-228`                                      | Responsive KPIs and system pulse         | fix              | Four headlines need to collapse in narrow chat panels, while CPU/RAM freshness context should not compete as another hero card.                                                                     | Use a component-width grid and compact bordered status strip.                                                        |
| `TeamRuntimeToday.tsx:230-310`                                      | Usage-source and recent-session sections | fix              | Secondary analytics need equal weight at wide widths and readable stacking at narrow widths.                                                                                                        | Use shared section headings/containers and a one-to-two-column container layout.                                     |
| `TeamRuntimeToday.tsx:262-310`                                      | Recent session section                   | fix              | The heading and list are self-explanatory; an additional sentence created an unnecessary second title line.                                                                                         | Keep a single heading followed directly by native-button session rows and stable empty/loading states.               |
| `TeamRuntimePanel.tsx:308-370`                                      | Member breakdown tab                     | fix              | Machine cards and 30/90-day drill-down are a distinct task from Today's summary analytics.                                                                                                          | Move the existing member-card family to its own org tab; keep the same card/detail interaction.                      |
| `OrganizationScopeHeader.tsx:37-52`, `TeamRuntimeToday.tsx:159-170` | Select accessible name                   | keep with reason | The shared `Select` has keyboard handling and visible selected text but does not expose an `aria-label`/`aria-labelledby` prop. Fixing only these callers would bypass the design-system component. | Treat an accessible-name prop for the shared Select trigger as a system-wide sweep candidate.                        |
| `OrganizationScopeHeader.tsx:51`                                    | 240px picker cap                         | keep with reason | This exact cap is the established Manage Org contract and prevents long org names from crowding tabs in a narrow pane.                                                                              | Keep it shared; revisit only as a coordinated header-token change.                                                   |
| `TeamRuntimeToday.tsx:292`                                          | 11px session timestamp                   | keep with reason | It matches existing Runtime member-card supporting metadata and remains secondary to the 14px session title.                                                                                        | Keep the supporting scale; do not reduce it further.                                                                 |
| `TeamRuntimeToday.tsx:184,230`                                      | 720px container breakpoint               | keep with reason | The split is driven by Runtime component width, and the same breakpoint already exists in shared `SidebarSplit`.                                                                                    | Keep the component query until layout tokens expose named container breakpoints.                                     |

Verdict counts: **fix 8**, **keep with reason 4**, **abstract 1**.

Accessibility check: headings remain semantic `h3` elements, recent sessions
are native buttons, tabs are shared native-button controls, refresh is labeled,
and interactive rows retain visible text. The shared Select accessible-name gap
is recorded as a component-level sweep candidate.

Design-system check: the UI reuses `OrganizationTabSwitch`, `Select`, `Avatar`,
`TeamMemberCard`, `SectionContainer`, section heading tokens, Runtime
typography, palette tokens, radii, and spacing utilities. No new color, shadow,
dropdown, avatar, card, or tab primitive was introduced.

Systematic sweep: Manage Org, local-project organization navigation, Runtime
Usage KPI cards, Team member cards, shared section containers, and existing
720px component layouts were compared. The selector/tab layout is now shared;
the only remaining cross-surface candidate is the Select trigger's missing
accessible-name API.
