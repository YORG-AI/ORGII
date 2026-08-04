---
name: architecture-audit
description: Systematic architecture audit and refactoring methodology for Rust and TypeScript codebases. Use before finalizing refactor, cleanup, unification, dead-code removal, module reorganization, domain rewrite, type/control-flow redesign, or tech-debt plans; also use for reviews involving naming overload, hidden defaults, duplicate logic, wire protocols, entry-point initialization parity, or resolver symmetry.
---

# Architecture Audit

Audit from acceptance criteria and authoritative ownership, not from compilation success alone.

## Core rules

1. Define observable acceptance criteria before proposing or editing code.
2. Trace the complete path across frontend, command/API boundary, core logic, persistence, and external wire payloads.
3. Treat semantic overload, wildcard/default branches, and cross-domain leakage as correctness risks.
4. Compare every initialization entry point and every resolver source with explicit matrices.
5. Inspect serialized output whenever data crosses a process or network boundary.
6. When one defect is found, classify it and sweep the whole relevant scope.
7. Preserve one authoritative owner for mutable state; reject snapshots and shadow booleans that can drift.
8. Separate audit-only findings from implementation; do not silently expand a focused PR.
9. Verify each phase before continuing and run proportional global verification at the end.
10. Report covered layers, intentionally skipped layers, evidence, and remaining risks.

## Workflow

1. Read [acceptance-criteria.md](references/acceptance-criteria.md) before producing a refactor plan or declaring an audit complete.
2. Select the relevant audit layers:
   - Read [audit-layers.md](references/audit-layers.md) for architecture, types, naming, defaults, domain boundaries, wire payloads, init parity, or resolver work.
   - Read only the layers applicable to the change, but state which of all ten were covered or intentionally skipped.
3. Read [systematic-sweeps.md](references/systematic-sweeps.md) after identifying a repeated defect class or when doing cleanup/unification.
4. Read [planning-and-execution.md](references/planning-and-execution.md) when producing a plan or implementing an approved refactor.
5. Read [failure-patterns.md](references/failure-patterns.md) when reviewing a broad rewrite, investigating an escaped defect, or checking whether a proposed design repeats a known failure mode.

## Delivery

Provide:

- authoritative source and ownership boundary;
- layers covered and skipped;
- root cause or audit findings;
- sweep scope and evidence;
- verification performed;
- remaining risks and intentionally deferred work.
