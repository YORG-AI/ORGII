# Frontend UI Audit — Diff Stats Unification

**Files:** `src/engines/ChatPanel/InputArea/hooks/useComposerSections.ts`, `src/engines/ChatPanel/ChatItems/EditActivityGroup/index.tsx`, `src/modules/WorkStation/shared/DiffFileSection/index.tsx`  
**Date:** 2026-07-17  
**Auditor:** Codex  
**Mode:** Post-implementation audit

## D1 — Raw HTML vs Design System

| Line                                  | Element                  | Verdict          | Reason                                                                                                         | Suggested change |
| ------------------------------------- | ------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:89-109`       | Inline summary container | keep with reason | Static inline text needs no interactive primitive; the diff values now use the shared badge.                   | —                |
| `EditActivityGroup/index.tsx:217-231` | Group summary spans      | keep with reason | The spans provide non-interactive layout and a decorative separator; the repeated value rendering was removed. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                        | Value                                | Verdict          | Reason                                                                                                     | Suggested change |
| --------------------------- | ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:96` | `h-0.5 w-0.5` separator              | keep with reason | Existing decorative dot sizing, unrelated to diff-value semantics and not repeated as a component pattern. | —                |
| —                           | New raw color/arbitrary color values | keep with reason | None introduced. `DiffStatsBadge` owns semantic success/danger colors.                                     | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                  | Value                            | Verdict          | Reason                                                                                                               | Suggested change |
| ------------------------------------- | -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:101-108`      | `DiffStatsBadge variant="plain"` | keep with reason | Uses inherited typography and semantic badge tokens; the former `text-green-500` / `text-red-500` literals are gone. | —                |
| `EditActivityGroup/index.tsx:224-230` | `DiffStatsBadge variant="plain"` | keep with reason | Shared component owns signs, zero suppression, spacing, and colors.                                                  | —                |

## D4 — Accessibility

| Line                                  | Element              | Verdict          | Reason                                                                     | Suggested change |
| ------------------------------------- | -------------------- | ---------------- | -------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:93-99`        | Decorative dot       | keep with reason | Remains `aria-hidden`; visible numeric text follows in DOM order.          | —                |
| `EditActivityGroup/index.tsx:221-223` | Decorative separator | keep with reason | Remains `aria-hidden`; no new click target or keyboard behavior was added. | —                |

## D5 — Visual Patterns Observed

| Pattern                                       | Where                                    |            Count | Verdict          | Suggested change                                                          |
| --------------------------------------------- | ---------------------------------------- | ---------------: | ---------------- | ------------------------------------------------------------------------- | --- |
| Shared diff-stat rendering                    | Composer files pill; edit activity group | 2 migrated sites | keep with reason | Both misses from the initial sweep now use `DiffStatsBadge`.              |
| Hand-built `+N/-N` rendering in audited sites | Audited files                            |                0 | keep with reason | The local color/sign/zero-suppression implementations were removed.       | —   |
| Status-bar diff totals from screenshot        | Local `origin/develop` comparison        |                1 | keep with reason | It already used `DiffStatsBadge`; no UI change was needed in this branch. | —   |

## Summary

- 2 prior fix candidates fixed
- 8 elements kept with documented reason
- 0 abstract candidates; the established `DiffStatsBadge` is now used at every audited UI site
