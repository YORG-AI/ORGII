---
name: frontend-ui-audit
description: Frontend UI consistency audit for React + Tailwind codebases. Use when reviewing component refactors, UI cleanup batches, or answering "should this use the design system?" — checks design-system adoption, arbitrary Tailwind values vs tokens, hardcoded sizes and colors, accessibility basics, and repeated visual patterns worth abstracting. Not for single-file bug fixes.
---

# Frontend UI Audit

A consistency pass over changed UI. It answers one question per site: **does this belong to the design system, or does it have a reason not to?**

> **Reconstructed 2026-08-23.** The original `SKILL.md` was absent from both the
> user-global and workspace paths for at least six weeks — 55 reports under
> `docs/frontend-ui-audit-*/` between 2026-07-12 and 2026-08-22 carry a
> "skill was unavailable, manual fallback" note. This file was rebuilt from the
> conventions those 45 report directories actually follow, so it should match
> what reviewers already expect. Correct it where it disagrees with your memory
> of the original.

## When To Use

- Before delivering a PR that touches `*.tsx` under `src/components/` or `src/modules/**/components/`
- Component refactors and UI cleanup batches
- Answering "should this use the design system?"

## When NOT To Use

- **Single-file bug fixes.** The noise-to-value ratio is too high. Fix the bug.
- Copy tweaks, i18n-only changes, or pure styling touch-ups with no structural change
- Performance work — that is `react-best-practices`
- Type or control-flow changes — that is `architecture-audit`

Running it when it wasn't needed costs a report nobody reads. Skipping it on a
component refactor costs consistency that is expensive to recover later.

## Verdict vocabulary

Every row gets exactly one:

| Verdict                     | Meaning                                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **fix** / **fix candidate** | Should adopt the design system or a token. Give the concrete change.                                                                               |
| **keep with reason**        | Deliberately not DS. **The Reason column is mandatory** — this is the audit's real value, because it stops the next pass re-flagging the same hit. |
| **abstract**                | The pattern recurs **3+ times**. Propose the seam, don't hand-inline it.                                                                           |
| **watch**                   | Suspected duplication not yet confirmed. Say what would confirm it.                                                                                |

A `keep with reason` row with an empty Reason column is an incomplete audit.

## The five dimensions

### D1 — Raw HTML vs Design System

Raw `<button>`, `<table>`, `<input>`, modal scaffolding where a DS primitive exists.

Legitimate `keep with reason` cases seen repeatedly: the DS primitive itself
(it cannot use itself); dynamic shapes the DS component's config-driven API
cannot express (ad-hoc SQL result grids, server-driven element trees); and
sticky/overlay/custom-hit-area headers.

A local shared scaffold used consistently across a cluster is `keep with reason`
for each member — converting one member fragments the cluster. If the cluster
is large, raise it under D5 instead.

### D2 — Arbitrary Tailwind Value vs Token

Sweep for `*-[var(--…)]` and other arbitrary bracket values. Verify against
`config/tailwind.config.js` and `src/config/workstation/tokens.ts`.

- **Bridge-layer rule:** vars that deliberately adapt a third-party theme to the
  app (e.g. `--cm-*` bridging a CodeMirror theme) are `keep with reason`.
- Computed values a single class cannot express — a `color-mix` focus ring —
  are `keep with reason`, optionally with a config-token suggestion.
- **Concentration matters more than count.** Many single-site uses is a cheap
  per-file cleanup. One file with six is the real finding.
- If a single var appears in **5+ non-bridge files**, that is a missing token
  mapping — raise it as `abstract`, not as N separate fixes.

### D3 — Hardcoded Sizes / Colors

Literal hex/rgb and pixel values. **Colors first** — they break theming and are
the most visible inconsistency. Sizes are lower priority when they are genuinely
one-off layout numbers.

### D4 — Accessibility Basics

`<div onClick>` / `<span onClick>` without keyboard semantics, missing labels,
click-only overlays with no `Escape`.

**Fix design-system components first.** A gap in `Tag`, `Menu`, or `Upload`
multiplies across every consumer; the same gap in one app-level component is
isolated. Rank by leverage, not by count.

A `<div onClick>` inside an already-interactive parent is `keep with reason`.

### D5 — Repeated Visual / Structural Patterns

Look for the same shell, wrapper, or dialog shape rebuilt per domain. Threshold
for `abstract` is **3+ occurrences**.

Name the seam concretely — "a `useReplayShell` hook plus `<ReplayShell>` owning
the common chrome, per-domain body only", not "consider extracting". If shared
atoms already exist, cite them: they prove the seam is real.

## Systematic Sweep Discipline

**A fix-candidate spanning multiple files is one sweep candidate, not N findings.**

When a fix would apply at many sites, do not fix them site-by-site silently.
Surface it as a sweep, report the hotspots with counts, and let the user decide
whether to land a config-level change. Count it once in the verdict totals.

This keeps the report honest: 10 sites of one problem is one decision, not ten.

## Output format

**Location:** `docs/frontend-ui-audit-YYYY-MM-DD/<ComponentName>.md` — one
date-stamped folder per batch, one file per audited component.

**Body:** a table, then verdict totals.

```markdown
# <Component> UI audit

| Line           | Element           | Verdict          | Reason                | Suggested change |
| -------------- | ----------------- | ---------------- | --------------------- | ---------------- |
| `File.tsx:294` | CLI version alert | keep with reason | Reuses `InlineAlert`… | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
```

For a whole-repo pass, use `GLOBAL.md` in the same folder, one `##` section per
dimension, plus a summary and a recommended order of attack.

**Always report the totals in the delivery message** so the user sees the
verdicts without opening the file.

## Discipline

- **Audit and fix are separate concerns.** Do not modify source in an audit-only
  pass; mixing them makes review impossible.
- Cite `file:line`. A finding without a location cannot be acted on.
- Do not invent findings to fill a table. `0 fix, 4 keep with reason` is a
  perfectly good audit and is more useful than manufactured churn.
