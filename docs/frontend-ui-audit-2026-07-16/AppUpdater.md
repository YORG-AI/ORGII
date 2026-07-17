# Frontend UI Audit — AppUpdater

**File:** `src/scaffold/AppUpdater/index.tsx` (507 LOC)

**Date:** 2026-07-16

**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element         | Verdict          | Reason                                                                                                                                     | Suggested change |
| ---- | --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| —    | Visible actions | keep with reason | Existing modal actions use `Button`, update preferences use `Checkbox`, and the download visualization is delegated to `DownloadProgress`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value              | Verdict          | Reason                                                                         | Suggested change |
| ---- | ------------------ | ---------------- | ------------------------------------------------------------------------------ | ---------------- |
| —    | Changed updater UI | keep with reason | No new arbitrary Tailwind color or spacing values are introduced in this file. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value              | Verdict          | Reason                                                                                                        | Suggested change |
| ---- | ------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Changed updater UI | keep with reason | Progress timing constants are behavioral values; visible sizing remains in existing design-system components. | —                |

## D4 — Accessibility

| Line   | Element                     | Verdict          | Reason                                                                                                                                                                  | Suggested change |
| ------ | --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 82–119 | persistent notice lifecycle | keep with reason | Manual close collapses rather than cancels the operation; reopening restores the same live state, while the notice inherits the Message close button's accessible name. | —                |

## D5 — Visual Patterns Observed

- Persistent-notice-to-collapsed-orb behavior is unique to long-running app downloads; no three-site abstraction candidate.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates
