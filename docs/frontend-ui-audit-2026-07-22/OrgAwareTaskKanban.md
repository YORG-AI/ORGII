# Frontend UI Audit — Organization-aware Task Kanban

**Scope:** Creator identity on Task Kanban cards and the shared List table.
**Summary:** 0 fix, 8 keep with reason, 0 abstract.

> The repository-routed `frontend-ui-audit` skill was unavailable in both documented skill locations. This report is the manual fallback using the required design-system, duplication, arbitrary-style, accessibility, and systematic-sweep checks.

|                                                    Line | Element                       | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ------------------------------------------------------: | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
|       `KanbanBoard/components/TaskCreator/index.tsx:18` | Creator avatar                | keep with reason | Reuses the established `Avatar` primitive, accepts an actual profile image, and supplies readable initials when none exists.                                | None.            |
|       `KanbanBoard/components/TaskCreator/index.tsx:31` | Avatar + name identity row    | keep with reason | One shared, truncating identity treatment serves card and table contexts; the full name remains available through `title`.                                  | None.            |
|         `KanbanBoard/components/TaskCard/index.tsx:155` | Card creator metadata         | keep with reason | Creator sits in the existing footer metadata row and wraps with existing card metadata instead of adding a new card region.                                 | None.            |
|           `TaskKanban/components/ListView/index.tsx:71` | Conditional Created by column | keep with reason | The column appears only when scoped tasks carry creator data, so Personal retains its compact established table.                                            | None.            |
|    `modules/shared/layouts/blocks/SessionTable.tsx:200` | Owner-column label override   | keep with reason | A small semantic override preserves the shared table while allowing Task List to say Created by and cloud management to keep Member.                        | None.            |
| `modules/shared/layouts/blocks/sessionTableItem.tsx:97` | List creator mapping          | keep with reason | Uses the same creator avatar component and the table's existing owner icon/label slots.                                                                     | None.            |
|         `KanbanBoard/components/KanbanColumn/index.tsx` | Remote card capabilities      | keep with reason | Reuses the established card and expresses unavailable open/drag actions by removing their existing affordances rather than adding a special visual variant. | None.            |
|            `TaskKanban/components/DiaryPanel/index.tsx` | Remote Diary tooltip          | keep with reason | Rows without a local session id omit the local-only hover wrapper while retaining the established Gantt rendering and click behavior.                       | None.            |

No new one-off button, raw color, arbitrary Tailwind value, or duplicated avatar treatment was introduced. Image avatars remain decorative because the adjacent visible name carries the identity; the initials fallback carries the same visible name context.
