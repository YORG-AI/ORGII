# Systematic Sweep Discipline

## Systematic Sweep Discipline (Added 2026-04)

**When you find one instance of a problem category, you MUST sweep the entire codebase for all instances before moving on.**

This was the single biggest failure mode in the 2026-04 audit cycle: fixing one `blocking I/O` site but not scanning for all others, fixing one `error swallowing` pattern but only in JSON/serde contexts.

### The Rule

For every issue found:

1. **Classify it** — what is the general pattern? (e.g., "sync I/O in async fn", "unwrap_or_default hiding errors", "hardcoded string instead of const")
2. **Write a grep pattern** that catches ALL instances of this class, not just the one you found
3. **Run the grep across the entire target scope** (e.g., all of `agent_core/`)
4. **Record the full hit list** before fixing any
5. **Fix ALL instances** or explicitly defer with user agreement

### Common sweep patterns

```bash
# Blocking I/O in async context
rg "std::fs::" --type rust -l  # then check if callers are async

# Error-swallowing unwrap_or_default
rg "unwrap_or_default\(\)" --type rust

# HTTP client construction hiding errors
rg "\.build\(\)\.unwrap_or" --type rust

# Hardcoded finish_reason strings
rg '"stop"|"tool_calls"|"end_turn"' --type rust

# Schema generators that may add unwanted fields
rg "SchemaSettings|into_root_schema" --type rust

# Repeated state lookups in one function (consolidation candidate)
rg "get_session\(&session_id\)" --type rust -c  # >1 per file = suspect

# Guaranteed-Some Option wrappers (ok_or followed by Some())
rg "ok_or.*\?\s*;" --type rust  # then check if result is wrapped in Some()

# Non-atomic multi-step DB writes (split-brain window)
rg "update_status|upsert_session" --type rust  # multiple calls in sequence = candidate for merge

# DEPRECATED fields still being assigned or read — remove or migrate first
rg -i "deprecated" --type rust -C 3  # then check: is the deprecated item still assigned/read?

# Types alive only in definition + re-export chains (zombie types)
# For each pub struct: count callers outside its own file + mod.rs re-exports + tests
# If all hits are definition/re-export/test → dead

# Cross-module naming collisions
# Export every pub struct name, sort, find duplicates across modules
rg "^pub struct " --type rust -l  # list files, then grep struct names across all
```

### TypeScript/JavaScript sweep patterns

```bash
# TypeScript: atoms serving multiple concerns
rg "Atom\b" --type ts -l  # list files, then check each atom name for conjunctions

# TypeScript: event handlers directly setting runtime status
rg "setRuntimeStatus|setIsRunning|isRunning\s*=" --type ts

# TypeScript: duplicate send paths (direct transport calls outside dispatcher)
rg "dispatchMessage|sendMessage" --type ts -l  # >1 file calling transport = suspect

# TypeScript: UI components importing transport/dispatch directly
rg "from.*dispatcher|from.*transport" --type ts  # should only appear in the dispatcher file

# TypeScript: atoms reset in multiple places for different concerns
rg "set\(.*Atom.*false\)" --type ts  # find atoms cleared in multiple locations
```

### Anti-pattern: "Fix the one, forget the class"

```
Round 1: Found blocking I/O in memory/commands.rs. Fixed it. Declared "blocking I/O: done."
Round 2: Found blocking I/O in init_helpers.rs, channel.rs, prompt_sections.rs, prompt_helpers.rs.

Why? Because round 1 only fixed the reported instance, never swept for the pattern.
```

---
