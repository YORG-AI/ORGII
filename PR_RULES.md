# ORGII Pull Request Rules

This tracked file is the repository-wide source of truth for pull requests.
It applies to humans and to every coding agent, including Codex, Claude, and
Cursor. Agent-specific instruction files may add implementation guidance, but
they must not weaken or contradict this policy.

## Single responsibility

- One pull request solves one problem or delivers one feature.
- Do not combine unrelated features, bug fixes, refactors, cleanup,
  formatting, or documentation.
- Supporting tests and documentation belong in the same pull request only
  when they directly verify or explain its single change.
- Put unrelated follow-up work in a separate branch and pull request.
- Before handoff, compare the final branch against its base and confirm every
  changed file belongs to the stated problem or solution.

## Title

Pull request titles must use a scoped Conventional Commit form:

```text
type(lowercase-kebab-scope): short imperative summary
```

Allowed types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`,
`build`, `ci`, `style`, and `revert`.

The scope is mandatory and must be lowercase kebab-case. Examples:
`feat(chat): add pinned actions` and `fix(session-replay): preserve turns`.

## Description

The description must begin with these top-level sections in this exact order:

```markdown
## Problem

<What is wrong, who or what is affected, and the root cause.>

## Solution

<What changed, the resulting invariant or behavior, and why this approach was chosen.>

## Potential risks

<Concrete regressions, compatibility concerns, unverified paths, or operational tradeoffs.>
```

All three sections must contain meaningful content. If no material risk
remains, say why. Do not replace them with `Summary`, `Overview`, or
`Test plan`.

A non-empty `## Verification` section is also required after the three
sections. It must list the exact commands and meaningful manual checks that
actually ran, their outcomes, and any relevant checks that did not run.
Additional sections such as `Audit`, screenshots, rollout notes, or rollback
details may follow the required sections.

## Base and diff integrity

- Start from the intended target branch and fetch its latest state before
  handoff.
- Resolve integration conflicts and rerun affected checks.
- Keep the published description synchronized with the final diff.
- Avoid unrelated merge commits, generated churn, and history rewrites after
  review begins. If history must change, tell reviewers what changed.

## Risk and verification evidence

- Verification must be proportional to risk and cover behavior at its owning
  boundary, not only a helper or selector.
- `Potential risks` must address applicable compatibility, data, concurrency,
  lifecycle, platform, rollout, and unverified-path concerns.
- Dependency, lockfile, database/schema, configuration, persistence,
  public-API, IPC, and wire changes must explain necessity, compatibility, and
  rollback or recovery.
- Destructive or difficult-to-reverse behavior requires an explicit rollback
  or recovery plan.
- User-visible UI changes need suitable screenshots or recordings, including
  relevant themes, viewport constraints, and loading/empty/error states. If
  visual evidence is not useful, explain why.
- Inspect the final diff for secrets, tokens, personal paths, private config,
  debug logs, build artifacts, caches, and unrelated formatting changes.

## Draft and review lifecycle

- Keep a pull request in Draft while material design choices, known blockers,
  migrations, or risk-proportionate verification remain incomplete.
- Mark it ready only when acceptance criteria are met and the description
  reflects the implementation.
- If scope or behavior changes materially after review starts, update the
  description and notify reviewers.

## Agent handoff

Any agent that creates or updates a pull request must:

1. Read this file before mutating the pull request.
2. Bring the title, description, base, and draft state into compliance
   in the same operation.
3. Read the published pull request back from GitHub and verify the result.
4. Report exact verification evidence and anything still incomplete.

The GitHub `PR policy` workflow enforces the machine-checkable title and
description rules. Repository branch protection should require its
`Enforce PR contract` check before merge. The remaining semantic rules are
mandatory review criteria even when automation cannot prove them.
