# Performance Surface and Lifecycle

### 1. Establish the performance surface

Read the changed call chain from its production entry point. Inventory every resource the change can create or retain:

- `setInterval`, recursive `setTimeout`, `requestAnimationFrame`, debounce, retry, backoff
- DOM/Tauri/network listeners and Realtime channels
- workers, subprocesses, watchers, file scans, git operations, database reads
- module globals, atom maps, per-store maps, promises, abort controllers, buffers
- React subscriptions, selectors, derived arrays, render-time sorting/grouping
- eager list/history/diff/replay loading

Use targeted searches, adapting paths to the diff:

```powershell
rg -n "setInterval|setTimeout|requestAnimationFrame|addEventListener|listen\(|subscribe|channel\(" src src-tauri
rg -n "new Map|new Set|WeakMap|cache|inFlight|buffer|queue|history" src src-tauri
rg -n "poll|refresh|retry|scan|watch|stream|delta|dispose|cleanup|abort" src src-tauri
```

Do not treat grep hits as findings. Trace ownership, start conditions, steady-state behavior, and cleanup.

### 2. Build the lifecycle matrix

For each resource, record the required behavior in these states:

| Dimension | States to check |
| --- | --- |
| App | start, idle, active, shutdown |
| Document | visible, hidden, focus return |
| Network | online, offline, retry/backoff |
| Identity | signed out, signed in, refresh, account switch, endpoint switch |
| Scope | personal org, cloud org, removed org, revoked share |
| Session | unopened, active, inactive, deleted, forked |
| Instance | primary, direct-launched secondary, launcher-created secondary |
| Source | discover, append, large append, compact/rewrite, rotate, delete |
| UI | clean load, old row active/open/pinned during refresh, restart |
| Transport | local ingest, upload, remote download, reconnect |

Flag any resource whose owner or terminal state is ambiguous.

### 3. Separate provider lifecycle from machine topology

For provider history, session identity, dedupe, or sync work, build a coverage
matrix before testing:

| Axis | Minimum relevant states |
| --- | --- |
| Provider | every changed provider plus every provider explicitly claimed as working |
| Raw transition | create, append, large append, compact/rewrite, rotate, fork/subagent, delete |
| App timing | cold start, source changes while ORG2 is open, rescan, restart |
| UI state | clean roster, previous row active/open/pinned, search/filter/load-more as needed |
| Topology | local ingest, isolated secondary, A upload, B download/reconnect |

Apply these validity rules:

- Treat each matrix cell as independent evidence. Two machines exercise
  topology; they do not create provider compaction, rotation, or lineage
  transitions automatically.
- Exercise the raw provider artifact or a faithful before/after fixture. Do not
  seed only normalized cache/database rows when the parser, watermark,
  identity, lineage, or dedupe contract is under test.
- Derive identity markers from the raw artifact. Do not fabricate identical
  group keys that merely restate the implementation assumption.
- Include an assumption-breaking fixture for identity logic, such as a
  rewritten transcript head with a changed first-message UUID but preserved
  ancestry.
- Observe local ingest and listability before enabling or asserting cloud
  upload. Verify upload cursor/payload and remote rendering separately.
- Keep the previous session active, open, or pinned while applying the source
  transition when exact-id hydration or force-reveal paths exist.
- Repeat rescan/restart once to prove idempotence and stable row/resource
  counts.
- Name every unexecuted provider or transition. Never summarize partial
  coverage as "multi-provider," "dual-machine," or "full lifecycle."
