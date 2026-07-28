# Frontend UI Audit — Project and Work Item Headers

**Scope:** Projects and Work Items list headers, detail/create headers, and the
corresponding Chat panel header publishers. Body content and Project Org
surface navigation are intentionally out of scope.

The repository-referenced `frontend-ui-audit` skill was unavailable at both
documented paths, so this report follows the fallback table convention in
`AGENTS.md`.

| Line                                                                                                                 | Element                       | Verdict  | Reason                                                                                                                           | Suggested change                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb/index.tsx:22`                                 | Shared project breadcrumb     | abstract | Project, Work Item, and creation headers repeated title sizing, truncation, separators, icon placement, and click behavior.      | Centralize explicit display segments, callbacks, the 40 / 24+36 character rules, and one first-level identity icon here. |
| `src/modules/ProjectManager/Projects/components/ProjectsPageHeader/index.tsx:80`                                     | Projects list header          | fix      | Identity and actions were published together as one content fragment, allowing controls to drift into the flexible title region. | Publish breadcrumb identity through `content` and controls through `trailing`.                                           |
| `src/modules/ProjectManager/WorkItems/components/WorkItemsPageHeader/index.tsx:352`                                  | Work Items list header        | fix      | The list header used the same monolithic publisher pattern and a different outer action gap.                                     | Use the semantic slot split and the shared compact action spacing.                                                       |
| `src/modules/ProjectManager/WorkItems/components/WorkItemDetail/WorkItemDetailHeader.tsx:37`                         | Work Item detail breadcrumb   | fix      | The detail view hand-built a 12px breadcrumb and omitted the short ID from the visible leaf title.                               | Use the shared 13px breadcrumb with Project > `short ID · title`, a first-level project/provider icon, and parent click. |
| `src/modules/ProjectManager/WorkItems/components/WorkItemDetail/index.tsx:286`                                       | Work Item detail publisher    | fix      | Detail navigation and property actions were attached to the flexible content slot.                                               | Publish the breadcrumb and action cluster independently and compose the same pieces inline.                              |
| `src/modules/ProjectManager/shared/components/DetailSplitLayout/index.tsx:119`                                       | Create/detail fallback header | fix      | Creation views retained a plain 12px title and raw header publication.                                                           | Route primitive breadcrumbs and fallback titles through the shared renderer; publish actions last.                       |
| `src/engines/ChatPanel/panels/ProjectPanelView.tsx:136`                                                              | Chat Project header           | fix      | The Project tab left the shared 40px header identity area blank and could not distinguish a GitHub-backed project.               | Publish Organization > Project with a first-level native or GitHub provider icon.                                        |
| `src/engines/ChatPanel/panels/WorkItemPanelView.tsx:494`                                                             | Chat Work Item header         | fix      | The Work Item tab published only property/delete actions, leaving no identity or provider hierarchy in the shared bar.           | Publish Project > `short ID · title`, use GitHub branding when synced, and retain actions in `trailing`.                 |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel.tsx`          | GitHub issue header           | fix      | State/number/title metadata was complete, but the first identity position lacked GitHub branding.                                | Prepend the shared GitHub integration icon while retaining the issue-state icon.                                         |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel.tsx` | GitHub pull-request header    | fix      | PR state, number, title, and branches were present without a provider identity icon.                                             | Prepend the shared GitHub integration icon and keep the PR-specific metadata grouping.                                   |
| `src/modules/MainApp/WorkManagement/GitHubWorkItemsView.tsx`                                                         | GitHub list header            | fix      | Repository, state, and search controls began without a provider identity marker.                                                 | Put the shared GitHub integration icon first in the published 40px content slot.                                         |

## Verdict summary

- Fix: 10
- Keep with reason: 0
- Abstract: 1
- Multi-file sweep candidates: 0

Accessibility check: clickable parent breadcrumbs remain keyboard-focusable
through the shared breadcrumb control, full labels remain available through
titles after visual truncation, decorative identity icons are rendered only
once, icon-only actions retain their existing labels and tooltips, and
separators remain hidden from assistive technology.
