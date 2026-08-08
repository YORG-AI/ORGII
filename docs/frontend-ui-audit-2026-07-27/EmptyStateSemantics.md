# Frontend UI Audit — Empty-State Semantics

**Files:** user-visible empty-value renderers under `src/components`, `src/features`, and `src/modules`
**Date:** 2026-07-27
**Auditor:** ORGII coding session

## D1 — Raw HTML vs Design System

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| — | Existing inline text wrappers | keep with reason | This sweep changes empty-value semantics only; the wrappers are non-interactive text/layout elements and do not have a covering design-system requirement. | — |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| — | Existing classes in audited renderers | keep with reason | No new arbitrary color or CSS-variable value was introduced by the empty-state changes. | — |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| — | Existing sizing and color classes | keep with reason | This issue class concerns semantic empty-state presentation; no new hardcoded size or color was introduced. | — |

## D4 — Accessibility

| Line | Element | Verdict | Reason | Suggested change |
|---|---|---|---|---|
| `src/components/ContextListDropdown/index.tsx:194` | Empty context list | fix | The same `AlertCircle` used for load failures was also used for a normal empty result. | Completed: the error icon remains only on the error branch. |
| Other changed dash fallbacks | Plain text empty values | keep with reason | A muted em dash is conventional table/metadata empty-value output and does not claim an error. | — |

## D5 — Visual Patterns Observed

- Pattern: ordinary missing optional metadata should use a quiet `—`, not `N/A` or a blocked/error icon.
- Migrated sites: testing framework label, image diff metadata, CLI installation source, CLI API/protocol lists, and the internal flow-awareness summary.
- Pattern: true operational states remain explicit. Permission unavailable, unsupported capability, failed probes, failed loading, cancelled jobs, and CI neutral/skipped states were intentionally not rewritten.

## Summary

- 7 empty-value render sites migrated to the neutral dash convention.
- 1 normal empty-state alert icon removed.
- 0 design-system abstractions required; the shared convention already exists in `SessionTable` and `SectionLayout/Table`.
- Residual `N/A` locale keys are either unused generic resources or technical diagnostics (for example FPS sampling unavailable), not confirmed instances of ordinary optional data being presented as an error.
