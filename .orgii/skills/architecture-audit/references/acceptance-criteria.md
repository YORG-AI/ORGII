# Architecture Audit Acceptance Criteria

## Core Principle: Acceptance Criteria First

Before writing any plan, define the **completion checklist** — measurable criteria the codebase must satisfy when done. Every phase must map to at least one checklist item.

```
- [ ] Zero compiler warnings (cargo check / tsc --noEmit)
- [ ] Zero clippy warnings (cargo clippy --all-targets)
- [ ] Zero hardcoded domain strings (grep for known patterns)
- [ ] Zero duplicate type definitions across modules
- [ ] Zero layer violations (lower layers do not import upper layers)
- [ ] All files under size limit (per workspace rules)
- [ ] No backward-compat shims remaining (grep "compat", "legacy", "backward")
- [ ] Pre-user schema changes modify canonical DDL directly; no `ALTER TABLE`, legacy rebuilds, or migration tests unless explicitly requested
- [ ] No duplicate logic patterns (manual audit of init/setup/registration flows)
- [ ] No unused pub items (compiler warnings or manual grep)
- [ ] Term overloading table complete (Layer 4)
- [ ] Default branch analysis complete (Layer 5)
- [ ] Core modules free of variant-specific leakage (Layer 6)
- [ ] Wire payloads inspected for bloat/unwanted fields (Layer 8)
- [ ] All entry points perform identical init steps — comparison matrix complete (Layer 9)
- [ ] Multi-field resolvers use symmetric fallback chains — fallback matrix complete (Layer 10)
- [ ] Every found issue class has been swept globally, not just fixed at the reported site
- [ ] No types alive only in definition + re-export + test chains (Layer 2 call-chain trace)
- [ ] No cross-module naming collisions (same type name, different fields)
- [ ] No config structs spanning multiple unrelated domains (embedding + learnings + model selection in one struct)
- [ ] No background subsystems calling full session resolvers that enforce model-presence invariants
- [ ] No `expect()` on fallback paths that share the same failure mode as the primary path
- [ ] Session-layer decisions (LLM model, account) stay in session records, not agent config layer
- [ ] User-visible control actions have one dispatcher/source of truth, not UI-side duplicate send/cancel paths
- [ ] Runtime-completed assistant output is written to the authoritative EventStore, not only broadcast over transient UI channels
- [ ] Cancel APIs distinguish user Stop from programmatic Force Send so one path cannot poison the next turn
- [ ] Long-running orchestration surfaces reconcile finality from durable state, not from optimistic UI/session assumptions
- [ ] Run status, session status, task status, and member activity are asserted as separate dimensions
- [ ] No ownerless `in_progress`/claimed work can be persisted; if open work remains after all workers are terminal, the run is explicitly abandoned/failed/cancelled, not running
- [ ] Multi-agent task tools are role-aware: member self-claim is distinct from coordinator assignment, and recoverable misuse returns structured guidance rather than trajectory-visible execution errors
- [ ] Live orchestration context (task board, inbox, member activity) is marked volatile or revision-keyed; it is never hidden inside a stale stable prompt cache
- [ ] Rendered E2E for orchestration proves final outcome, durable invariants, prompt/context evidence, readable UI evidence, and absence of hidden tool-error trajectory leaks
- [ ] Rendered E2E does not use debug/helper endpoints as the side-effect path for the user-visible behavior under assertion; helpers may seed or inspect only
- [ ] Control/sentinel records (`redo:*`, batch envelopes, internal markers) are excluded from user-actionable UI registries and transcript input surfaces unless explicitly rendered as diagnostic metadata
- [ ] Team-mode / Agent Org member identity is sourced from runtime `member_id`/member name, not inferred from `agent_definition_id` or `agent_id` (one definition can back coordinator + multiple members)
- [ ] Drained inbox/mailbox messages are persisted as visible turn input before agent execution; LLM-only ephemeral attachments are not enough, and raw XML/internal payloads must not leak into the UI transcript
- [ ] Member turn completion maps to idle/available semantics, not terminal session completion; run finality must remain separate from per-turn member availability
- [ ] Task queue progress is event-driven: blocked assigned tasks are not notified early, dependency completion redispatches newly ready assigned tasks, and coordinator/cross-member tool calls cannot persist another member's work as `in_progress`
- [ ] Agent Org E2E asserts production inbox drain: unread member inbox rows must become visible turn input through the real member session path, and ready assigned open work must have either an active owner turn or unread wake row
- [ ] Adding a new E2E helper (`setTextarea`, custom drain endpoint, seeded snapshot helper, etc.) includes a sweep of all semantically matching call sites so old helpers do not keep driving the wrong DOM/runtime shape
- [ ] Turn finality has exactly one authoritative source (an FSM or equivalent monotonic state machine); `runtimeStatus` atoms, rendered events, heuristic timestamps, and streaming deltas are UI mirrors only and MUST NOT drive queue-flush decisions
- [ ] Every turn-ending signal (provider terminal, stream end, error, user Stop) carries a monotonically increasing generation counter; signals whose generation does not match the current turn are silently discarded
- [ ] The queue dispatcher reads a single gate (`turnPhase === "idle"`) — it does not read multiple atoms, boolean flags, or heuristic conditions to decide whether to send or queue
- [ ] User Stop and programmatic interrupt (Force Send cancel) travel separate code paths with explicit intent encoding; no shared cancel atom, flag, or default branch handles both simultaneously
- [ ] No separate "hold" atom or boolean flag shadows FSM state (e.g. "don't flush even if idle"); the FSM phase is the only source of truth for whether the queue may flush
- [ ] Provider events (stream end, tool call complete, error) are FSM *inputs*, not direct setters of `runtimeStatus`; the FSM transitions on them, the UI mirrors the FSM
- [ ] For every user-visible send/submit control, there is exactly one code path from button click to message dispatch; UI shortcut paths and background dispatcher paths that perform the same mutation are eliminated
- [ ] Atoms or flags that serve more than one concern (e.g. "signal user Stop" AND "gate draft restoration") are split; each concern has its own named atom with a single documented purpose
```

---
