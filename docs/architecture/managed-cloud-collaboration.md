# Managed Cloud Collaboration

This document is the canonical design for ORGII managed-cloud collaboration.
It replaces the dated implementation audits and E2E run reports that were
useful while the feature was being built but are not part of the maintained
product contract.

## Product model

ORGII has three collaboration scopes with deliberately different semantics:

1. **Personal** is local/private. It never exposes a cloud organization's
   roster and cannot be used as a destination for direct member sharing.
2. **Organization** is the durable team boundary. Membership, roles, sharing
   policy, Projects, Work Items, comments, and direct session grants are
   authorized by the managed backend.
3. **Link capability** is an explicit guest path. Creating a link is separate
   from sharing with an organization member and the link can expire or be
   revoked independently.

Selecting an organization member creates a direct grant; it does not generate
a link. The recipient sees that session in **Shared directly with me** without
copying a URL. Link generation remains an explicit action and always exposes a
Copy control.

An imported shared session or local Codex/Claude/Cursor history is immutable
at its source. The user may inspect and comment where cloud authorization
exists. On the first attempt to continue the conversation, ORGII asks for a
local repository/workspace with the same Git remote plus the local account and
model, then creates a writable ORGII-owned fork and sends the message there.
Cancelling the picker preserves the unsent message.

## Ownership and authorization

- The backend is authoritative for cloud organization membership, roles,
  policies, grants, invite state, ownership transfer, and deletion.
- Local aliases connect a cloud organization to local project storage but do
  not redefine cloud identity or authorization.
- A direct grant, organization visibility, and a link capability are separate
  authorization concepts. Code must not infer one from another.
- Revocation and deletion invalidate local caches immediately through
  Realtime. Polling is recovery-only.
- The last-owner and role-transition invariants are server transactions, not
  UI conventions.

## Data planes

### Durable entities

Projects and Work Items use local-first persistence plus a durable SQLite
outbox. Each mutation has one typed entity operation, a stable entity ID,
organization scope, and an expected remote version. The sync engine:

1. commits the local mutation and outbox record atomically;
2. pushes eligible operations in order;
3. applies optimistic concurrency control (OCC) at the backend;
4. pulls/invalidate on Realtime signals;
5. resolves or surfaces conflicts deterministically; and
6. retries at the recorded eligibility time, including while the app is
   hidden.

Remote tombstones are permanent convergence operations. User-initiated local
deletion may remain recoverable, so the sync worker uses a distinct purge path.
Deleting a Project also deletes its child Work Items; children must never be
silently converted into standalone items by an FK default.

### Comments and owner-local agent follow-up

Session comments are durable cloud rows. Replies retain their thread root,
edits and deletes converge live, and status is a typed tri-state value. The
literal `@agent ` prefix is stored verbatim and rendered as a pill. It starts
work only when submitted on the original cloud session by that session's
owner; on another member's import, a read-only replay, or a writable fork it
is ordinary comment text with no suggestion, assignment, toast, or agent side
effect.

There is no cloud task/lease/claim plane. An owner submission enters the same
local queue/send path as an ordinary message and therefore uses the owner's
locally authenticated account and selected model. The backend returns a
viewer-derived ownership capability, the UI and runner both fail closed on
it, and only the owner may stamp the resulting `agent_report`. The Address
Comments action operates on an explicit selection and links agent output back
to the originating comment using the exact dispatched turn generation.
Top-level comments have exactly one scope: no event anchor means a session
note applying to the session as a whole; an event anchor means a round comment.
Address Comments groups both scopes, selects both by default, permits
scope-level selection, and carries the scope into the agent briefing.

### Background upload policy

Eligible local sessions continue publishing to a background-upload-enabled
organization even when that organization is not the active UI scope. Repo
scopes, session ownership/admission, the administrator sharing minimum,
per-session choices above that minimum, entitlement backoff, and server
authorization remain mandatory. Local EventStore writes, login/roster
changes, reconnect, visibility recovery, and explicit actions drive those
pushes. Inactive-org policy broadcasts are not kept subscribed, so the shared
roster also refetches on focus/visibility return and through one five-minute,
visible-only safety timeout. That timeout is single-flight, pauses while
hidden, and refreshes only `list_my_orgs`; it does not scan or upload sessions
itself. The sync engine remains event-driven and decides whether a roster
change requires a session pass.

The policy does not download teammate replays. Remote-session listing stays
demand-driven for the active organization, and replay import remains an
explicit user action. This keeps one org-wide background policy and avoids a
second automatic download scheduler, queue, and retained fingerprint state.

### Presence

Presence is ephemeral awareness, never the source of truth for membership,
locks, or durable edits. Only the active organization publishes tracking
state. Inactive channels may listen, and connection-wide updates are
coalesced to stay within transport limits. Leaving an organization untracks
before disposing its channel.

### Execution locks

A Work Item execution lock identifies the active session and role. Start,
retry, cancel, and lock-holder UX all use the same Work Item orchestrator in
detail views and ChatPanel. Lock release is serialized as explicit JSON
`null`; an omitted field means "unchanged", not "clear".

## Create with AI

Create with AI uses `builtin:os` by default (the Work Item Manager persona was
retired; `manage_work_item`/`manage_project` are ordinary built-in tools) and
follows one durable-draft invariant:

1. Before launch, the UI allocates a cloud-aware Work Item ID and writes one
   draft in the selected Project or organization-scoped standalone store.
2. The launched session is durably linked to that draft.
3. The Work Item Manager receives a volatile system section containing the
   exact `short_id` and Project scope. It updates the linked draft instead of
   creating a duplicate unless the user explicitly asks for multiple items.
4. `project_slug` is omitted for standalone Work Items; a fake Personal
   Workspace Project is never invented.
5. The session link survives every update and is visible from both the Work
   Item and session surfaces.

The Work Item Manager may research with read-only tools and mutate Projects or
Work Items through their typed management tools. It cannot edit repository
files or run shell commands.

## Client boundaries

- `org2CloudClient` owns authenticated HTTP transport and token refresh.
- Entity-specific clients own wire shapes for organizations, sessions,
  shares, comments, Projects, and Work Items.
- `org2CloudRealtimeClient` owns subscription lifecycle and reconnect
  behavior.
- `org2CloudSyncEngine` owns durable project-plane convergence and retry.
- Jotai atoms expose UI state; they do not become alternate persistence or
  authorization layers.
- Rust owns local project/work-item transactions, session persistence,
  execution locks, agent tools, and desktop commands.

There is one endpoint snapshot per authenticated operation. A token refresh
must not silently move an in-flight request to a different endpoint. Unknown
credential/provider rows are preserved when an older build updates a known
account so account refresh cannot destroy forward-version data.

## Desktop instance isolation

Instance profiles are created at build time. Instance `N` has an independent:

- product name and bundle identifier;
- deep-link schemes;
- ORGII home and WebKit storage;
- IDE server port (`13846 + N`); and
- local managed-cloud proxy port (`17887 + N`).

The supported commands are:

```sh
pnpm run tauri:build:fast
open src-tauri/target/dev-build/bundle/macos/ORG2.app

pnpm run tauri:build:fast -- --instance 2
pnpm run tauri:open:instance -- --instance 2
```

Copying and patching an already-built app bundle is not supported because it
can leave the frontend, schemes, ports, and data home with different identity.

## Backend migration contract

Backend RPC/schema changes live in `orgii-cloud-infra` and must be deployed
before a desktop release that calls them. Until the first public release,
`supabase/migrations/0001_org2_cloud_schema.sql` is the only canonical
baseline: the disposable project is wiped, the baseline is applied once, and
the `org2_cloud` PostgREST schema exposure is rechecked. Incremental dated
deltas are deliberately not retained during this pre-release phase.

Desktop code must not auto-run production SQL or mutate production
organizations during tests. Production migration is an explicit operator
step with the infra repository's migration history as the source of truth.

## Verification contract

Changes to this feature are complete only when the affected layers pass their
own gates. A skipped scenario is never reported as a pass.

- TypeScript: typecheck plus focused unit tests for changed clients, atoms,
  reducers, filters, clipboard, and UI state machines.
- Rust: focused crate tests for changed persistence, tools, session launch,
  locks, and sync code.
- Local cloud: Auth/PostgREST/Realtime/RPC assertions against disposable users.
- Rendered single-instance UI: signed-out/in, organization scope, sharing,
  import/fork, comments, presence policy, Projects, Work Items, and real
  provider execution.
- Rendered dual-instance UI: isolation, invite/join, direct share, link share,
  revoke, comments, Project/Work Item convergence, lock ownership, offline OCC,
  roles, leave/remove/reactivate, ownership transfer, and typed deletion.
- Create with AI: a real provider must update the single linked draft through
  the rendered composer, preserve the session link, and create no duplicate.
- Packaging: build and launch main plus Instance 2 concurrently and verify
  listener ownership and visible identity.

OAuth-live runs use an explicitly selected real account. Tests must never fall
back to an unrelated account merely because it is available.

## Explicit non-goals

- Presence is not a durable collaborative document protocol.
- Typed business entities are not converted wholesale to CRDTs. A future rich
  document body may use a per-artifact CRDT behind a narrow interface while
  metadata, ACLs, Work Item transitions, tombstones, and OCC stay typed.
- Guest links do not grant organization membership.
- Import does not make remote history writable.
- Browser OAuth callback allow-list verification and production migration are
  external release gates; deterministic local JWT tests do not prove them.
