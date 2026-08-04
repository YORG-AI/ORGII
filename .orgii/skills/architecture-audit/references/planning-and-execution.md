# Architecture Refactor Planning and Execution

## Plan Structure

### Phase ordering rules

1. **Delete dead code first** (Phase 1 always) — reduces noise for all subsequent phases
2. **Unify duplicated logic next** — establishes shared foundations
3. **Structural/naming cleanup last** — cosmetic changes on a clean codebase

### Phase granularity

Each phase must be:

- **Independently verifiable**: `cargo check` passes after each phase
- **Scope-bounded**: affects at most ~20 files
- **Both-sides**: if a Rust change affects frontend types, the frontend change is in the SAME phase

### Plan anti-patterns

- "Create abstraction" without "Wire it in" — creates dead code. Every "create" must have "integrate" + "delete old" in same phase.
- Phase marked "complete" without verification — each phase ends with `cargo check --all-targets` + zero warnings.
- Auditing one layer (Rust) but not the other (TypeScript) — audit both together for shared concepts.
- "Future" or "deferred" items — if worth noting, worth doing now or explicitly descoping with user.
- "It compiles, ship it" — compilation says nothing about semantic correctness.
- "Not in my task scope" — always expand audit scope to adjacent systems that share terminology.

---

## Execution Discipline

### Before each phase

1. Verify starting state: `cargo check` passes, note warning count
2. Read the files you're about to change (never edit blind)

### After each phase

1. `cargo check` — zero errors
2. Warning count must be <= previous (ideally decreasing)
3. For frontend: `tsc --noEmit` or equivalent

### Global verification (after all phases)

Run every checklist item. If any fails, the refactor is not complete.

---

## Common Refactoring Patterns

### Unifying duplicate initialization

When two code paths do overlapping work:

1. List every step each path performs (side by side)
2. Mark shared steps vs variant-specific steps
3. Create factory function for shared steps, returns "base" result
4. Each variant calls factory, adds variant-specific work
5. Delete duplicated code from each variant

### Eliminating dead abstractions

1. Confirm zero callers (grep + compiler warnings)
2. If abstraction SHOULD be used: integrate it properly
3. If not: delete entirely
4. Never leave "aspirational" code

### Replacing hardcoded strings with typed constants

1. Define enum/const in ONE canonical location
2. Add `as_str()` for serialization boundaries
3. Replace ALL occurrences (including tests and comments)
4. Verify zero remaining with grep

### Introducing an FSM to replace scattered boolean/atom state

When "is the system in state X?" is answered by reading multiple atoms:

1. List every atom/boolean that contributes to the answer
2. Define the complete set of mutually-exclusive states (phases) as an enum/union type
3. Write transition functions for each edge (e.g. `beginTurn`, `markRunning`, `markTerminal`, `forceIdle`)
4. Add a monotonically increasing `generation` field; bump it synchronously in every `begin*` transition
5. All signal handlers check `signal.generation === current.generation` before acting
6. Delete the old atoms; derive any needed UI booleans from the FSM phase
7. Verify: grep the codebase for the old atom names — zero remaining reads outside the FSM module

---
