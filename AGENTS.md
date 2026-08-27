# AGENTS.md — Agent Skill Routing for ORGII

This file orients Codex / orgii agents working in this repo. It tells you **which audit / methodology skill to invoke** for which kind of task, and what to deliver before declaring work done.

> Test conventions — where a test file belongs, how to name it, and what each
> suite actually runs — live in `CONTRIBUTING.md` under **Where tests live**.
> This file does not restate them; it is about skill routing.

This is **advisory**, not a hard contract. Use judgment based on PR size and risk.

---

## Skill Routing Table

| Scenario                                                                                                                   | Skill to invoke                     | When                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust / TypeScript architecture, types, dead code, FSM, naming overload, wire protocol, init parity                         | `architecture-audit`                | Before finalizing a refactor plan; before cleanup/unification PRs; when reviewing a domain rewrite                                            |
| Frontend UI consistency, design-system component usage, arbitrary Tailwind values, a11y basics, visual-pattern duplication | `frontend-ui-audit`                 | Before delivering a PR that touches `*.tsx` under `src/components/` or `src/modules/**/components/` (component refactors, UI cleanup batches) |
| React performance, re-renders, async waterfalls, bundle size, heavy dependencies, virtualization, high-frequency events    | `react-best-practices`              | For performance-focused React implementation/review; not for routine styling, copy, or single-file bug fixes without a performance concern    |
| Both architecture and React performance change together                                                                    | Run both, keep findings categorized | Apply `architecture-audit` to ownership/boundaries and `react-best-practices` to measured React runtime concerns                              |
| E2E test surface (Playwright / WebDriver), test stability                                                                  | `e2e-testing`                       | When adding or repairing rendered E2E specs                                                                                                   |
| Polling, timers, caches, subscriptions, workers, streaming, sync, scans, pagination, multi-instance lifecycle              | `org2-performance-guard`            | Before delivering any change that can consume CPU/RAM/I/O while active, idle, hidden, or across repeated open/close cycles                    |

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

### UI copy conventions

- Settings-row descriptions must not end in sentence-ending punctuation (`.` or `。`) in any locale. Internal punctuation between sentences is allowed.

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

### Touching background work or retained state

Run `org2-performance-guard` whenever a change adds or modifies polling, timers, retries, subscriptions, workers, streaming hot paths, caches, scans, sync loops, pagination, or multi-instance state. Apply its lifecycle matrix and rejection rules even when performance is not the feature's headline. State the performance verdict and concrete verification in the delivery message.

### Pull request contract

Every pull request created or updated by an agent MUST follow these rules.
Before touching a pull request, read `PR_RULES.md`; it is the tracked,
repository-wide source of truth shared by Codex, Claude, Cursor, and human
contributors. If this section and `PR_RULES.md` ever differ, follow
`PR_RULES.md` and fix the stale adapter in the same pull request.

Hard gates: one responsibility; a scoped Conventional Commit title; the
required `Problem`, `Solution`, `Potential risks`, and `Verification` sections;
and a final GitHub read-back of the published pull request.

#### Single responsibility

- One PR solves one problem or delivers one feature. Do not combine multiple
  features, unrelated bug fixes, opportunistic refactors, cleanup, formatting,
  or documentation changes in the same PR.
- Supporting tests and documentation belong in the same PR only when they
  directly verify or explain that PR's single change.
- If requested work contains independent changes, split them into separate
  branches/worktrees and separate PRs.
- If a new unrelated request arrives after a PR has been opened, do not append
  it to the existing branch. Create a separate PR.
- Before handoff, compare the branch against its base and confirm every changed
  file maps directly to the PR's stated problem or solution.

#### Description format

The PR description MUST begin with these top-level sections in this exact
order:

```markdown
## Problem

<What is wrong, who or what is affected, and the root cause.>

## Solution

<What changed, the resulting invariant or behavior, and why this approach was chosen.>

## Potential risks

<Concrete regressions, compatibility concerns, unverified paths, or operational tradeoffs.>
```

- Do not replace these sections with `Summary`, `Overview`, or `Test plan`.
- Do not leave a required section blank. If no material risk remains, state
  that explicitly and explain why.
- Additional sections such as `Audit`, `Verification`, screenshots, or rollout
  notes may follow the three required sections.
- Before handing off a PR, read back the published description (for example
  with `gh pr view`) and verify the section names and order.

#### Base and diff integrity

- Start from the intended target branch. Before handoff, fetch its latest state
  and check whether the PR needs to be updated or conflicts resolved.
- After resolving conflicts or incorporating target-branch changes, rerun the
  checks affected by that integration.
- Keep the published description synchronized with the final diff. Remove
  claims about approaches, files, or behavior that are no longer present.
- Avoid unrelated merge commits and generated churn. Do not rewrite published
  history after review begins unless necessary; if history must change, use the
  safest available method and tell reviewers what changed.

#### Verification evidence

- List the exact commands and meaningful manual checks that actually ran,
  together with their outcomes.
- State which relevant checks were not run and why. Do not write unsupported
  claims such as "all tests pass" or infer runtime/performance improvement from
  typecheck or code shape alone.
- Verification must be proportional to risk and cover the changed behavior at
  its owning boundary, not only a helper or selector.

#### Risk, compatibility, and rollback

- `Potential risks` must name concrete compatibility, data, concurrency,
  lifecycle, platform, rollout, and unverified-path concerns that apply. Do not
  use a generic "no risk" statement to avoid analysis.
- Dependency or lockfile changes, database/schema migrations, configuration or
  persistence format changes, and public API/IPC/wire changes must state why
  they are necessary, how compatibility is handled, and how to roll back or
  recover.
- Destructive or difficult-to-reverse behavior requires an explicit rollback
  or recovery plan before the PR is ready for review.

#### UI and security evidence

- User-visible UI changes should include screenshots or recordings appropriate
  to the change, including relevant themes, viewport constraints, and
  loading/empty/error states. If visual evidence is not useful, say why.
- Before handoff, inspect the diff for secrets, tokens, personal paths, private
  configuration, debug logs, build artifacts, caches, and unrelated formatting
  changes. None may be included.

#### Draft, ready, and review lifecycle

- Keep the PR in Draft while material design choices, known blockers, required
  migrations, or risk-proportionate verification remain incomplete.
- Mark the PR ready only when its acceptance criteria are met and the
  description reflects the current implementation.
- If scope, behavior, or the chosen solution changes materially after review
  begins, update the description and notify reviewers instead of silently
  changing direction.

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
