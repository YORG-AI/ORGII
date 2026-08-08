# Frontend UI Audit — WorkstationSidebarConnector

**File:** `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/index.tsx` (669 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                           | Verdict          | Reason                                                                                                                                   | Suggested change |
| ---- | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 576  | `<NavigationSidebar>` integration | keep with reason | The guide is injected through the sidebar's existing `beforeAddNewActions` extension point rather than adding independent chrome markup. | —                |
| 589  | Pre-list layout `<div>`           | keep with reason | Pre-existing layout-only wrapper around the organization selector; the guide integration does not duplicate or alter it.                 | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                                                        | Suggested change |
| ---- | ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | The guide integration adds no Tailwind values; styling remains encapsulated in shared sidebar/dropdown components and tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                   | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------- | ---------------- |
| —    | —     | keep with reason | The guide integration adds no hardcoded sizes or colors. | —                |

## D4 — Accessibility

| Line | Element                | Verdict          | Reason                                                                                                                                                                  | Suggested change |
| ---- | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 602  | `<SidebarGuideButton>` | keep with reason | Accessibility is delegated to the audited reusable guide component, which owns the labeled trigger, progress semantics, menu roles, keyboard activation, and dismissal. | —                |

## D5 — Visual Patterns Observed

- Pattern: sidebar top actions are composed through `beforeAddNewActions` and `onAddNew`, preserving the existing traffic-light/search/collapse alignment.
- Pattern: canonical Session, Organization, and Project state is projected into derived progress; the guide adds no persistence or second completion store.
- Pattern: connector-level callbacks retain ownership of navigation and state transitions while the presentational control remains reusable.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
