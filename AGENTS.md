# AGENTS.md — Agent Skill Routing for ORGII

This file orients Codex / orgii agents working in this repo. It tells you **which audit / methodology skill to invoke** for which kind of task, and what to deliver before declaring work done.

> Cursor IDE users: live UI-feature delivery rules live in `.cursor/rules/ui-feature-workflow.mdc`. This file does **not** replace those — it's about skill routing for AI agents, not unit-test gates.

This is **advisory**, not a hard contract. Use judgment based on PR size and risk.

---

## Skill Routing Table

| Scenario                                                                                                                   | Skill to invoke                            | When                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust / TypeScript architecture, types, dead code, FSM, naming overload, wire protocol, init parity                         | `architecture-audit`                       | Before finalizing a refactor plan; before cleanup/unification PRs; when reviewing a domain rewrite                                            |
| Frontend UI consistency, design-system component usage, arbitrary Tailwind values, a11y basics, visual-pattern duplication | `frontend-ui-audit`                        | Before delivering a PR that touches `*.tsx` under `src/components/` or `src/modules/**/components/` (component refactors, UI cleanup batches) |
| Both layers change together (e.g. "refactor module X")                                                                     | Run both, emit **two independent reports** | Don't fold them; each skill has its own decision rules                                                                                        |
| E2E test surface (Playwright / WebDriver), test stability                                                                  | `e2e-testing`                              | When adding or repairing rendered E2E specs                                                                                                   |

Skills live at:

- `~/.orgii/skills/architecture-audit/SKILL.md` (user-global)
- `~/.orgii/skills/frontend-ui-audit/SKILL.md` (user-global)
- `.orgii/skills/architecture-audit/SKILL.md` (workspace copy, if present)
- `.orgii/skills/e2e-testing/SKILL.md` (workspace)

If the skill block isn't already prefetched in your context, read its `SKILL.md` before acting on it.

---

## Default Delivery Flow

### Touching `*.tsx` files (UI work)

Before declaring a UI-touching task complete, ask:

1. **Is this a single-file bug fix?** If yes, skip `frontend-ui-audit` (its own "When NOT To Use" rules out single bug fixes — noise-to-value ratio is too high).
2. **Is this a component refactor, UI cleanup, or "should this use the design system?" question?** If yes, run `frontend-ui-audit` over the changed files and drop a report in `docs/frontend-ui-audit-YYYY-MM-DD/<ComponentName>.md` using the skill's output format. Summarize fix / keep-with-reason / abstract counts in the delivery message so the user can see verdicts without opening the file.
3. **Did you find a fix-candidate that spans multiple files?** Don't fix site-by-site silently. Surface it as a sweep candidate per the skill's `Systematic Sweep Discipline` section and let the user decide whether to land a config-level change.

### Touching Rust / backend / type-level / cross-layer code

Before finalizing a refactor plan, walk the 10-layer `architecture-audit` checklist (or at least the layers the change clearly touches). State which layers you covered and which you intentionally skipped.

### Touching both

Don't merge the reports. Two skills, two reports. Cross-reference in the delivery message if relevant.

---

## What This File Does NOT Do

- It does **not** force every PR to produce an audit report. Single bug fixes, copy tweaks, hotfix patches → just ship.
- It does **not** override the skills' own `When NOT To Use` rules.
- It does **not** replace `.cursor/rules/ui-feature-workflow.mdc` for human/Cursor flow (unit tests + TEST_CASES.md + acceptance criteria). Those gates are about delivery quality; this routing is about which methodology to apply.
- It does **not** mandate any commit-message format (commitlint handles that), any lint rule, or any pre-commit hook. Audit reports are docs, not gates.
- It does **not** lock in skill content. If `~/.orgii/skills/*/SKILL.md` updates, this file's routing still applies — read the current SKILL.md, not your memory of it.

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
