# Frontend UI Audit — GitHub Issue Detail

**Files:**

- `src/modules/ProjectManager/WorkItems/components/GitHubIssueThreadSurface.tsx`
- `src/modules/ProjectManager/WorkItems/components/WorkItemThreadSurface/index.tsx`
- `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/index.tsx`
- `src/modules/ProjectManager/WorkItems/components/WorkItemProperties/PeopleSection.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel.tsx`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueTimelineItems.tsx`

**Date:** 2026-08-04
**Auditor:** Codex
**Method:** Manual fallback because the configured `frontend-ui-audit` skill is unavailable.

## D1 — Raw HTML vs Design System

| Line                                   | Element                  | Verdict          | Reason                                                                                                                                                    | Suggested change |
| -------------------------------------- | ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GitHubIssueThreadSurface.tsx:117–132` | GitHub issue detail body | keep with reason | Adapts remote issue data into the existing `WorkItemThreadSurface`; it does not introduce another card, property, or timeline implementation.             | —                |
| `IssueDetailPanel.tsx:207–214`         | Scrollable issue body    | keep with reason | The wrapper only owns the remaining height/overflow boundary while the shared thread owns content width, spacing, property pills, and cards.              | —                |
| `IssueDetailPanel.tsx:216–282`         | Comment composer footer  | keep with reason | Preserves the established `RichMarkdownEditor`, shared Buttons, drop-target behavior, and close/reopen actions while the duplicate issue body is removed. | —                |
| `IssueTimelineItems.tsx:26–79`         | GitHub activity rows     | keep with reason | Uses the shared activity timeline primitives and remains a data renderer consumed by the canonical thread.                                                | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                                 | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | No new arbitrary Tailwind colors, spacing values, or shadow values were introduced; the issue body inherits `WORK_ITEM_THREAD_TOKENS`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                        | Value                 | Verdict          | Reason                                                                                         | Suggested change |
| --------------------------- | --------------------- | ---------------- | ---------------------------------------------------------------------------------------------- | ---------------- |
| `IssueTimelineItems.tsx:66` | `size={18}` avatar    | keep with reason | Retains the established compact activity-header avatar size used by the shared timeline cards. | —                |
| `IssueDetailPanel.tsx:197`  | `size={14}` back icon | keep with reason | Retains the existing mini-button icon scale and is outside the replaced issue body.            | —                |

## D4 — Accessibility

| Line                                   | Element                                | Verdict          | Reason                                                                                                                                                                                            | Suggested change |
| -------------------------------------- | -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GitHubIssueThreadSurface.tsx:120–128` | Repository, status, and assignee pills | keep with reason | Exposes only remote fields with valid behavior: repository and assignee are read-only, while status routes to close/reopen. Unsupported local Work Item fields and the overflow menu are omitted. | —                |
| `IssueDetailPanel.tsx:101–120`         | External GitHub action                 | keep with reason | The icon-only action retains an accessible label, link target, and safe external-link relation.                                                                                                   | —                |
| `IssueDetailPanel.tsx:222–280`         | Comment and state actions              | keep with reason | The editor retains a visible placeholder/test identity, and all actions remain named native/shared buttons with disabled/loading states.                                                          | —                |

## D5 — Visual Patterns Observed

- GitHub Issues, source-control issue detail, and My Station issue tabs now flow through the same `IssueDetailPanel` adapter and the Inbox `WorkItemThreadSurface` composition.
- Repository/status metadata, issue description, and GitHub activity use the shared property-pill and bordered timeline-card hierarchy.
- No multi-file design-system sweep candidate remains in the changed issue-detail surface.

## Summary

- 0 fixes recommended
- 10 kept with documented reason
- 0 abstract candidates
