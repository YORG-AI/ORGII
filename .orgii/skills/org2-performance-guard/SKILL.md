---
name: org2-performance-guard
description: Prevent CPU, RAM, I/O, background-work, and false-green lifecycle regressions in ORG2. Use when adding or reviewing polling, timers, Realtime subscriptions, event listeners, workers, streaming paths, caches, pagination, provider-owned transcript ingestion or identity/dedupe, external-history scans, cloud sync, source-control loading, per-session state, true-machine verification, or multi-provider/multi-instance behavior; also use before delivering a performance refactor or any feature that stays alive while the UI is idle or hidden.
---

# ORG2 Performance Guard

Apply a lifecycle-first audit. Preserve correctness and realtime behavior while making background work demand-driven, shared, bounded, scoped, and disposable.

## Non-negotiable invariants

Require all applicable invariants before delivery:

- Keep idle CPU close to zero. Do not add continuous work merely to detect possible change.
- Prefer push invalidation over polling. Keep polling only as a documented, low-frequency safety net.
- Pause non-critical polling, scans, animation work, and retries while `document.visibilityState === "hidden"`; revalidate once on visibility/focus return.
- Treat durable outbox, lease, and safety work as explicit exceptions. Bound their frequency, backoff, and scope instead of disabling correctness-critical work blindly.
- Single-flight equivalent requests. Concurrent consumers must share one promise or coordinator.
- Key cloud/user data by endpoint + authenticated user + resource scope. Never key security-sensitive caches by `orgId` or `sessionId` alone.
- Bound every app-lifetime `Map`, `Set`, array, buffer, queue, log, and worker-owned session registry. Use LRU/TTL/pagination and explicit eviction.
- Evict per-session state on session deletion, worker crash/dispose, auth or endpoint switch, org removal, and feature unmount as applicable.
- Subscribe to the narrowest state slice. A session view must not rerender for unrelated sessions' streaming deltas.
- Coalesce bursty updates before crossing React, IPC, database, or serialization boundaries.
- Keep hot streaming/parser loops allocation-light. Avoid repeated clones, full-buffer parses, formatting, and JSON conversion per delta.
- Keep blocking filesystem, database, git, and process work off async executor threads and render-critical paths.
- Load large histories, request rounds, diffs, and replay segments on demand; do not eagerly materialize invisible data.
- Isolate secondary Tauri identities completely: data home, external-history home, ports, cookies/auth, and app-lifetime caches.
- Treat provider ingestion, local identity/listability, UI hydration, cloud transport, and remote rendering as separate verification boundaries. Passing A-to-B sync does not prove the upstream local lifecycle.
- Test every provider and raw source transition claimed by the change. Do not infer Claude Code compaction coverage from Codex append coverage, or vice versa.
- Keep rendered E2E strict. Missing UI must fail with diagnostics; never turn a regression into `console.warn`, catch-and-continue, or a debug-helper bypass.

## Workflow

1. Read [surface-and-lifecycle.md](references/surface-and-lifecycle.md) to inventory active/idle/hidden behavior and repeated mount, account, endpoint, org, repo, and session transitions.
2. Read [runtime-patterns.md](references/runtime-patterns.md) when selecting or reviewing polling, push invalidation, single-flight, caches, history loading, subscriptions, privacy scopes, or equivalent-path sweeps.
3. Read [verification-and-delivery.md](references/verification-and-delivery.md) before declaring the work complete.

Do not claim a performance improvement from typecheck or unit tests alone. Provide concrete lifecycle evidence proportional to the changed runtime path.
