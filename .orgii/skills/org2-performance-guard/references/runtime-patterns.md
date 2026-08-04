# Runtime Performance Patterns

### 4. Choose the correct pattern

Apply the smallest applicable pattern:

- **Push + safety TTL:** subscribe to authoritative change events; use a slow TTL only to recover missed events.
- **Visibility-aware recursive timeout:** keep at most one timer, clear it while hidden, run once and reschedule on return. Prefer this over overlapping intervals.
- **Single-flight coordinator:** key by identity and resource, share the in-flight promise, carry an invalidation version/generation, and prevent stale completion from overwriting newer state.
- **Bounded LRU/TTL:** refresh recency on read, cap entry count, give failures a short TTL, and provide lifecycle eviction.
- **Per-store state:** use `WeakMap<Store, ...>` when multiple Jotai stores or rendered instances can exist in one process.
- **Narrow subscription:** use per-session atoms/selectors or keyed stores rather than reading a global delta map.
- **Burst coalescing:** batch updates once per frame or bounded debounce; preserve terminal/final events.
- **Demand-driven loading:** paginate or fetch details only after expansion/selection; retain only the visible or recently used window.
- **Generation guard:** discard late async results after stop, restart, account switch, endpoint switch, or a newer request.

### 5. Sweep equivalent paths

After finding one issue, search for every semantic peer. A fix is incomplete if another surface still owns a parallel implementation.

Typical ORG2 sweeps:

- Sidebar + management panel + share dialog + Work Item hooks fetching the same roster
- Visible and hidden polling paths
- Primary launcher and direct secondary executable startup
- Positive, negative, and in-flight cache entries
- Worker success, crash, dispose, session deletion, and app shutdown
- Local session, cloud member session, guest import, fork, and external CLI history
- Production action and rendered E2E action

Unify duplicate resource ownership before tuning individual call sites.

### 6. Protect correctness and privacy

Performance changes must not weaken:

- realtime propagation after push invalidation
- revocation/removal disappearance
- durable outbox retries and tombstones
- account/endpoint/org data isolation
- first-load and focus-return freshness
- session fork/history integrity
- terminal streaming events

Capture identity and generation at request start. Before committing a result, confirm the current identity/generation still matches. Do not display a previous identity's cached rows while refreshing.
