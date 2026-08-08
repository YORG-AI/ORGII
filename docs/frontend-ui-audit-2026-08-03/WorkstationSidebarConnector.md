# Frontend UI Audit — WorkstationSidebarConnector

**File:** `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/index.tsx` (763 LOC)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                               | Verdict          | Reason                                                                                                                                       | Suggested change |
| ---- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Invite guide action wiring            | keep with reason | The changed connector code adds navigation and spotlight intent only; the rendered guide continues to use `SidebarGuideButton`.              | —                |
| 580  | Organization guide action wiring      | keep with reason | The connector reuses the singleton Launchpad creator and shared spotlight overlay; no parallel form or guide surface is rendered.            | —                |
| 698  | Test panel and guide sibling controls | keep with reason | A flex wrapper gives the independent developer panel and product guide separate triggers while preserving the sidebar header action pattern. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                                                      | Suggested change |
| ---- | ----------------------- | ---------------- | ----------------------------------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | The guide action and scenario wiring add no Tailwind value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                                                        | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | The guide action and scenario wiring add no visual constants. | —                |

## D4 — Accessibility

| Line | Element                               | Verdict          | Reason                                                                                                                                                                                         | Suggested change |
| ---- | ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 587  | Localized permission-aware spotlight  | keep with reason | Managers target the existing named invite button; read-only members target a non-interactive member region with explicit localized permission copy, without creating a competing focus target. | —                |
| 593  | Localized organization-name spotlight | keep with reason | The action targets the existing named `Input`; the creator owns programmatic focus, submission gating, errors, and cancellation.                                                               | —                |
| 698  | Development-only panel gate           | keep with reason | The Slot owns production unmounting while the connector separately forces authoritative live routing outside development.                                                                      | —                |

## D5 — Visual Patterns Observed

- Pattern: sidebar education actions and development tooling share the header action rail but use independent triggers, panels, and ownership.

## Summary

- 0 fixes recommended
- 8 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
