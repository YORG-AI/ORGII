# Frontend UI Audit — Cloud Members Section

**Scope:** Manage Organization member identity, About me, and leave-organization action.
**Summary:** 0 fix, 4 keep with reason, 0 abstract.

> The repository-routed `frontend-ui-audit` skill was unavailable in both documented skill locations. This report is the manual fallback using the required design-system, duplication, arbitrary-style, accessibility, and systematic-sweep checks.

|                         Line | Element                      | Verdict          | Reason                                                                                                                                                                                    | Suggested change |
| ---------------------------: | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|  `ManagementSections.tsx:89` | Shared member identity label | keep with reason | One helper preserves the established name, owner badge, and self badge treatment across About me and Members without duplicating markup.                                                  | None.            |
| `ManagementSections.tsx:469` | About me section             | keep with reason | Reuses `SectionContainer` and `SectionRow`, preserving the Manage Organization page's existing card hierarchy, spacing, responsive layout, and typography.                                | None.            |
| `ManagementSections.tsx:479` | Leave organization action    | keep with reason | Uses the design-system `Button` with `variant="danger"` and `appearance="outline"`, which provides the requested secondary-style border and danger text without a one-off class override. | None.            |
| `ManagementSections.tsx:530` | Members section              | keep with reason | Continues using the established member controls and adds the shared `SectionRow` empty state when no other active members remain.                                                         | None.            |

No new raw color, arbitrary Tailwind value, custom button, or duplicated card treatment was introduced. The leave action remains a semantic button with its existing disabled state and explicit confirmation flow. No multi-file sweep candidate was found.
