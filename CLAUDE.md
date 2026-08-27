# CLAUDE.md — Agent Skill Routing for ORGII

@PR_RULES.md

This file orients Claude / orgii agents working in this repo. It tells you **which audit / methodology skill to invoke** for which kind of task, and what to deliver before declaring work done.

> Test conventions — where a test file belongs, how to name it, and what each
> suite actually runs — live in `CONTRIBUTING.md` under **Where tests live**.
> This file does not restate them; it is about skill routing.

This is **advisory**, not a hard contract. Use judgment based on PR size and risk.

The exception is pull request policy: `PR_RULES.md` is mandatory, not
advisory, for every pull request created or updated by Claude or a Claude-based
agent.

---

## Skill Routing Table

| Scenario                                                                                                                   | Skill to invoke                     | When                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust / TypeScript architecture, types, dead code, FSM, naming overload, wire protocol, init parity                         | `architecture-audit`                | Before finalizing a refactor plan; before cleanup/unification PRs; when reviewing a domain rewrite                                            |
| Frontend UI consistency, design-system component usage, arbitrary Tailwind values, a11y basics, visual-pattern duplication | `frontend-ui-audit`                 | Before delivering a PR that touches `*.tsx` under `src/components/` or `src/modules/**/components/` (component refactors, UI cleanup batches) |
| React performance, re-renders, async waterfalls, bundle size, heavy dependencies, virtualization, high-frequency events    | `react-best-practices`              | For performance-focused React implementation/review; not for routine styling, copy, or single-file bug fixes without a performance concern    |
| Both architecture and React performance change together                                                                    | Run both, keep findings categorized | Apply `architecture-audit` to ownership/boundaries and `react-best-practices` to measured React runtime concerns                              |
| E2E test surface (Playwright / WebDriver), test stability                                                                  | `e2e-testing`                       | When adding or repairing rendered E2E specs                                                                                                   |
| Cloud sync / session sharing / collab correctness (share, push/retract, fork, replay, comments, continuation)              | `dual-instance-verification`        | Before declaring any sharing/sync change "verified"; when a sharing bug escaped earlier testing                                               |

Skills live at:

- `.orgii/skills/architecture-audit/SKILL.md` (workspace)
- `.orgii/skills/frontend-ui-audit/SKILL.md` (workspace)
- `.orgii/skills/react-best-practices/SKILL.md` (workspace; ORGII overlay for Vercel's React guidance)
- `.orgii/skills/e2e-testing/SKILL.md` (workspace)
- `.orgii/skills/dual-instance-verification/SKILL.md` (workspace; 双机实测 protocol for cloud sync / sharing)
- `.orgii/skills/org2-performance-guard/SKILL.md` (workspace)

If the skill block isn't already prefetched in your context, read its `SKILL.md` before acting on it.

---

## Root-Cause-First Bug Fixing

When malformed, stale, duplicated, or unexpected data appears in the UI:

1. **Do not start with a UI filter, hidden row, fallback label, or string-pattern special case.** First determine whether the value is real persisted/remote domain data or only a presentation defect.
2. Identify the authoritative source, inspect the actual stored payload, and trace every transformation and writer back to the earliest boundary that created the invalid state.
3. Fix the invariant at that authoritative boundary: user-input parsing, API/RPC ingestion, persistence write, sync reconciliation, or canonical state projection.
4. Add a regression test at the producing boundary proving the invalid state can no longer be created. A selector/render test alone is not sufficient.
5. Treat historical pollution separately: inventory dependent data, get confirmation before destructive cleanup, perform the narrowest cleanup, then read back the authoritative source.
6. UI filtering is allowed only when exclusion is an explicit product requirement or defense-in-depth **after** the source fix. It must never be the sole fix for invalid upstream data.
7. Do not change adjacent valid behavior unless the user explicitly requests it.

Before declaring the issue fixed, report the authoritative source, root cause, producing write path, source-level invariant, historical remediation, and verification evidence.

Review gate: any UI predicate introduced to hide malformed data must cite an explicit product requirement. If the value violates the domain model, reject the UI-only patch until the producing path is fixed and covered by a regression test.

---

## Default Delivery Flow

### Pull requests

Before creating or updating any pull request, read and follow `PR_RULES.md`.
It is the tracked source of truth shared by Claude, Codex, Cursor, and human
contributors.

Hard gates: one responsibility; a scoped Conventional Commit title; the
required `Problem`, `Solution`, `Potential risks`, and `Verification` sections;
and a final GitHub read-back of the published pull request. If this summary
and `PR_RULES.md` differ, follow `PR_RULES.md` and fix this adapter.

### Touching `*.tsx` files (UI work)

Before declaring a UI-touching task complete, ask:

1. **Is this a single-file bug fix?** If yes, skip `frontend-ui-audit` (its own "When NOT To Use" rules out single bug fixes — noise-to-value ratio is too high).
2. **Is this a component refactor, UI cleanup, or "should this use the design system?" question?** If yes, run `frontend-ui-audit` over the changed files and drop a report in `docs/frontend-ui-audit-YYYY-MM-DD/<ComponentName>.md` using the skill's output format. Summarize fix / keep-with-reason / abstract counts in the delivery message so the user can see verdicts without opening the file.
3. **Did you find a fix-candidate that spans multiple files?** Don't fix site-by-site silently. Surface it as a sweep candidate per the skill's `Systematic Sweep Discipline` section and let the user decide whether to land a config-level change.

### React performance-focused work

Use `react-best-practices` only when performance is part of the task: re-renders, async waterfalls, bundle/startup cost, heavy dependencies, virtualization, high-frequency events, or subscription scope. Apply its ORGII filter before upstream guidance: Next.js/RSC/server-only rules are inapplicable, SWR is not introduced by default, and runtime performance claims require measurement rather than typecheck-only evidence.

### Touching Rust / backend / type-level / cross-layer code

Before finalizing a refactor plan, walk the 10-layer `architecture-audit` checklist (or at least the layers the change clearly touches). State which layers you covered and which you intentionally skipped.

### When multiple methodologies apply

Run every applicable skill. Keep architecture, React performance, and UI-consistency findings clearly categorized. Only skills that define an audit-report format require a report; `react-best-practices` is implementation/review guidance and does not create a report by default.

---

## What This File Does NOT Do

- It does **not** force every PR to produce an audit report. Single bug fixes, copy tweaks, hotfix patches → just ship.
- It does **not** make `react-best-practices` a gate for every `*.tsx` edit. Styling, copy, ordinary UI assembly, and routine single-file bug fixes do not trigger it unless performance is explicitly in scope.
- It does **not** replace the skills' own `When NOT To Use` rules.
- It does **not** mandate any commit-message format (commitlint handles that), any lint rule, or any pre-commit hook. Audit reports are docs, not gates.
- It does **not** lock in skill content. If `.orgii/skills/*/SKILL.md` updates, this file's routing still applies — read the current SKILL.md, not your memory of it.

---

## Audit Report Conventions

- **Location:** `docs/<skill-name>-YYYY-MM-DD/<ComponentName>.md` (one date-stamped folder per audit batch, one file per audited component).
- **Format:** follow the `## Output Format` section in the relevant skill verbatim — tables with Line / Element / Verdict / Reason / Suggested change columns.
- **`keep with reason` rows MUST fill the Reason column.** That's the audit's value-add — preventing the next pass from re-flagging the same hit.
- **Don't modify source code in an audit-only PR.** Audit and fix are separate concerns; mixing them makes review impossible.

---

## When You're Unsure

- If you don't know which skill applies, **lean toward running `frontend-ui-audit` for UI changes and `architecture-audit` for type/control-flow changes**. Both being run when only one was needed costs nothing; missing one is a real gap.
- If you're certain the user wants direct implementation and not an audit (e.g. "just fix this bug"), do that — don't insert an audit pass unprompted.
- If the user asks "why didn't audit catch X?", check whether X is in scope for the skill they're invoking before assuming the audit failed. (`architecture-audit` is type/architecture, not UI consistency — see `frontend-ui-audit` for the latter.)
