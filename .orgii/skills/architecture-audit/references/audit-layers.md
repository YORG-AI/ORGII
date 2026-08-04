# The 10-Layer Architecture Audit

## Contents

- Layers 1–3: compilation, dead code, and naming
- Layers 4–7: semantic overload, defaults, leakage, and developer confusion
- Layers 8–10: wire payloads, entry-point parity, and resolver symmetry

## The 10-Layer Audit

Every audit MUST cover all 10 layers. Previous failures came from only covering layers 1-3, then layers 1-7 (missing wire protocol and init parity), then layers 1-9 (missing resolver symmetry).

### Layer 1: Compilation Correctness

- Does it compile? (`cargo check`, `tsc --noEmit`)
- Zero warnings? (`cargo clippy --all-targets`)

### Layer 2: Dead Code & Structural Deduplication

- Duplicate functions/structs across modules?
- Parallel code paths doing the same work?
- Abstractions created but never wired into execution path?
- Types that only appear in definition + re-export chains + tests?

**Method: Call-Chain Tracing (not static grep)**

For each major entry point:

1. Identify entry point (e.g., "user sends message" -> Tauri command -> handler)
2. Trace forward: what functions does it call? What structs does it construct?
3. Mark every touched function/struct as "alive"
4. Everything NOT marked is a deletion candidate
5. For "alive" items: is the same work done in >1 place? -> duplication candidate

Static grep for `TODO`, `legacy`, `dead` only finds self-documented problems. It misses structs never instantiated, functions never called, and duplicate logic in parallel paths.

**CRITICAL: Reference counting is NOT a dead code audit.** A type with 15+ grep hits can still be dead if all hits are: (a) its own definition, (b) re-export chains (`types/mod.rs` → `session/mod.rs`), (c) internal conversion methods, and (d) tests that only exercise those conversions. Trace from **business entry points** (Tauri commands, API handlers, gateway dispatchers) forward — if no production code path constructs or consumes the type, it's dead. See anti-pattern #26.

### Layer 3: Naming Consistency

- Are renamed items updated everywhere?
- Old names still referenced in comments/strings?

### Layer 4: Semantic Overloading (CRITICAL — Often Missed)

**Search for the same word used with different meanings across the codebase.**

Method: Pick every domain term and search ALL usages. Build a table:

```
Term: "gateway"
Usage 1: ProviderSpec.is_gateway -> means API aggregator
Usage 2: AgentVariant::Gateway -> means message routing agent
Usage 3: GATEWAY_AGENT_TYPES -> means Azure cross-provider proxy
VERDICT: Rename usages 1 and 3 to avoid confusion
```

Common overloaded terms: gateway, session, channel, provider, context, runtime, config, state, manager, handler, bridge, proxy, client.

### Layer 5: Default Branch Analysis (CRITICAL — Often Missed)

**Find every `match` with `_ =>` or `else` catch-all and ask: "Is the default correct for ALL current and future variants?"**

Dangerous pattern:

```rust
match variant {
    Sde => SdePromptBuilder,
    _ => OsPromptBuilder, // Custom agents silently get OS identity!
}
```

Audit every:

- `match x { ..., _ => default }` — is the default truly universal?
- `if is_os { ... } else { ... }` — does the else work for Custom/Gateway/future variants?
- `unwrap_or(some_default)` — is the default always correct?

### Layer 6: Cross-Domain Concept Leakage (Often Missed)

**Check if domain-specific concepts leak into shared/core modules.**

Examples: `sde_config` field on shared `SessionRuntime`, hardcoded `AgentVariant::Os.agent_id()` in shared work item code, display labels "SDE Agent" hardcoded in shared aggregation code.

Method: For every file in `core/` or shared modules, grep for variant-specific terms. Each hit needs justification.

### Layer 7: "New Developer Confusion" Test (Often Missed)

Read the code as if you've never seen the codebase. For each function/struct:

1. Does the name accurately describe what it does?
2. Would a new developer understand this without tribal knowledge?
3. Are there misleading names that suggest a relationship that doesn't exist?

### Layer 8: Wire Protocol & Serialization Audit (CRITICAL — Added 2026-04)

**Check what the code ACTUALLY SENDS over the wire, not just what the source looks like.**

This layer was added after `schemars::openapi3()` silently injected `$schema`, `title`, `nullable`, and `default` fields into tool schemas. The Rust source looked perfectly reasonable — the problem was only visible in the serialized JSON output, and only triggered by a specific proxy resolving the `$schema` URL.

Method:

1. **Dump real payloads**: For every external API call (LLM, HTTP, WebSocket), add a temporary debug dump of the serialized body to a file. Inspect the actual bytes, not the source structs.
2. **Check schema generation libraries**: If using `schemars`, `serde_json::to_value`, or any schema generator, inspect the output for fields the target API does not expect (`$schema`, `title`, `nullable`, `default`, `examples`, `$ref`).
3. **Test against actual endpoints**: A payload that "should work" per the source code may fail at a proxy or gateway. Always verify with a real call, not just `cargo test`.
4. **Measure token impact**: For LLM APIs, check `prompt_tokens` in the response. If it's 10x higher than expected, the payload has hidden bloat.

Dangerous patterns:

```rust
// Looks fine in source, but openapi3() adds $schema URL, title, nullable
schemars::generate::SchemaSettings::openapi3()

// Fix: use draft07 with no meta_schema
schemars::generate::SchemaSettings::draft07()
    .with(|s| { s.meta_schema = None; })
```

Checklist:

- Every `to_value()` / `to_string()` that crosses a network boundary: inspect the output
- Every schema generator: verify no unwanted fields in output
- Every proxy/gateway in the call chain: test with real payloads

### Layer 9: Init Parity Across Entry Points (Added 2026-04)

**Every entry point (production, test, E2E, API endpoint) must perform the SAME initialization steps.**

This layer was added after the E2E test endpoint (`/agent/test/sde`) skipped `AgentSession` registration, causing `init.rs` to miss definition-level disabled tools — but production code via Tauri commands did register it.

Method:

1. **List ALL entry points** that create or initialize a session:
   - Tauri commands (production)
   - HTTP API endpoints (gateway/test)
   - Test helpers (`#[cfg(test)]`)
   - CLI entry points
2. **For each entry point, list the initialization steps** it performs (in order)
3. **Build a comparison matrix**: rows = entry points, columns = init steps
4. **Every cell must be filled** — if an entry point skips a step, it needs explicit justification
5. **Missing steps are bugs**, not "simplifications for testing"

Dangerous pattern:

```rust
// Production path: registers definition, then inits session
state.register_session(agent_session).await;
ensure_session_initialized(&state, &session_id, &model).await;

// Test endpoint: skips registration, so init can't read definition
// This means disabled_tools from definition are never applied!
ensure_session_initialized(&state, &session_id, &model).await;
```

### Layer 10: Resolver Symmetry (Added 2026-04)

**When a single function resolves multiple fields using a priority chain (overrides → cache → DB → fallback), every field MUST follow the same chain unless there is an explicit, documented reason to diverge.**

This was found in `identity.rs` where `model` only checked overrides + runtime (2 layers), while `account_id` and `workspace_root` checked overrides + runtime + DB (3 layers). The DB always had a valid `model` (required at creation time), but the resolver skipped it — causing an error on app restart when the frontend lost its `lastModelSelectionAtom` and the in-memory runtime hadn't been initialised yet.

Method:

1. **Find every multi-field resolver** — functions that resolve N related fields from the same set of sources
2. **Build a fallback matrix**: rows = fields, columns = data sources. Mark which sources each field checks.
3. **Every cell should be filled** — if a field skips a source, ask "why doesn't field X check source Y?"
4. **Check the DB query trigger condition** — if the DB query is conditional (lazy), verify the condition accounts for ALL fields, not just a subset

Dangerous pattern:

```rust
// model checks 2 layers, account_id and workspace check 3 — asymmetric!
let model = overrides.model
    .or_else(|| runtime.model.clone());  // stops here — no DB fallback
let model = model.ok_or("model is required")?;  // errors on app restart

let account_id = overrides.account_id
    .or_else(|| runtime.account_id.clone())
    .or_else(|| db_record.account_id.clone());  // has DB fallback

// Fix: all fields follow the same chain
let model = overrides.model
    .or_else(|| runtime.model.clone())
    .or_else(|| db_record.model.clone())  // now symmetric
    .ok_or("model is required")?;
```

Also watch for the DB query gate:

```rust
// BAD: gate only checks 2 of 3 fields — model miss won't trigger DB
let db_record = if account_id.is_none() || workspace.is_none() { query_db() }

// GOOD: gate checks all fields that may need DB fallback
let needs_db = model.is_none() || account_id.is_none() || workspace.is_none();
let db_record = if needs_db { query_db() }
```

Also audit for **dimension mismatch**: when a boolean flag (like `is_channel`) is used to branch behavior, check whether the flag's semantic dimension matches the actual requirement. Example: `is_channel_session` (dimension: "message source") was used to decide workspace path (dimension: "agent type"). OS Agent from the UI had no workspace — but `is_channel_session` was `false` for UI-launched sessions, so it hit the wrong branch.

---
