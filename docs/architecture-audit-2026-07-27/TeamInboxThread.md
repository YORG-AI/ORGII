# Architecture Audit — Team Inbox Thread and Kanban Refresh

**Scope:** Team Inbox full Work Item loading/editing, shared Work Item presentation policy, canonical Start Agent handoff, Session-tab navigation, and local/cloud Kanban manual refresh.
**Date:** 2026-07-27

## Layer 1 — Compilation correctness

- Focused Vitest suites: passed.
- TypeScript `tsc --noEmit`: passed.
- Focused ESLint: passed.

## Layer 2 — Dead code and structural deduplication

- Removed the body-only `useTeamInboxWorkItemBody` path.
- `useTeamInboxWorkItem` now resolves the full canonical item used by both `WorkItemContent` and `WorkItemProperties`.
- Moved `toWorkItemPartialUpdate` out of `WorkItemPanelView` so the Chat Panel and Team Inbox share one write-payload mapper.
- The ordinary Work Item view and Team Inbox both use one `WorkItemContent`; only an explicit presentation policy differs.
- `WorkItemThreadLayout` now owns the centered reading frame and metadata-band composition; `WorkItemThreadSection` owns the static card shell.
- To-Do and Workflow share `WORK_ITEM_THREAD_TOKENS`, while Workflow retains the existing `CollapsibleSection` state owner rather than introducing a second collapsible abstraction.
- Thread-only To-Do draft state is component-local and is never persisted until a non-empty item is committed.
- `ChatPanelWorkItemActionRequest` is a transient one-slot command envelope. It carries intent only; the canonical Work Item orchestrator remains the sole execution owner.

## Layer 3 — Naming consistency

- Added `presentation: "default" | "thread"` rather than an ambiguous boolean such as `hideSessions`.
- `start_agent` is named as a navigation action request instead of overloading ordinary `open_work_item`.
- `usePendingWorkItemAction` names the only bridge from the transient request to the canonical Work Item start command.
- Added a dedicated `open_session` navigation intent. Opening a Session no longer overloads `open_session_comment` with empty comment/thread IDs.
- `refreshKanbanSources` names the local/cloud fan-out without claiming ownership of either cache.

## Layer 4 — Semantic overloading

| Term          | Meaning                                                                   | Verdict                                                                                      |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| thread        | One Work Item activity flow containing workflow/session cards and history | Distinct from a Session comment thread; scoped to `WorkItemContent` presentation.            |
| thread layout | Stateless Work Item-domain presentation primitives                        | Owns composition/tokens only; it does not own persistence, collapse state, or orchestration. |
| Session open  | Open/focus a Session Chat Panel tab                                       | Explicit `open_session`; comment anchoring remains `open_session_comment`.                   |
| refresh       | User-triggered authoritative revalidation                                 | Local roster and cloud teammate snapshots keep their own identity/single-flight owners.      |
| start request | One-shot UI intent for the matching canonical Work Item                   | Not workflow state and not persisted in the tab; claimed before async orchestration begins.  |

## Layer 5 — Default branch analysis

- `resolveWorkItemContentSectionPolicy` handles both closed presentation variants and is unit-tested.
- `default` preserves the legacy tabs plus linked-Session table for existing consumers.
- `thread` omits that table, renders workflow/history inline, and renders output only when proof of work exists.
- Thread description transitions are explicit: read → editing → dirty → saved/cancelled. Save is disabled in editing/clean state.
- Start transitions are explicit: Inbox idle action → resolve/open canonical Work Item → publish matching request → atomically claim request → existing orchestrator validates configuration/locks and starts or reports failure.
- A claimed request is cleared before the async call, so remounts and repeated React effects cannot replay it. A non-matching Work Item cannot claim it.
- The transient channel holds at most one unclaimed request. A newer navigation intent supersedes an older unclaimed intent, preventing a hidden tab from starting unexpectedly when visited later.
- Read/update failures are explicit UI states; they do not fall back to fabricated data.

## Layer 6 — Cross-domain concept leakage

- Project persistence stays behind `projectApi` and the shared Work Item payload mapper.
- Team Inbox owns selection and presentation only.
- Thread primitives live under the Work Item component domain rather than a global shared package because the reading width, metadata band, and density are Work Item-specific.
- Agent execution remains exclusively owned by the canonical Work Item surface. Team Inbox publishes intent but does not mount a second orchestrator (which would duplicate collaboration-lock, auto-review, and stale-session lifecycles).
- Chat Panel atoms remain the sole owner of Session tab creation/focus.
- Kanban composes refresh callbacks but does not take ownership of session/cloud caches.

## Layer 7 — New developer confusion test

- The presentation policy documents exactly which legacy elements are absent.
- The thread layout API uses semantic slots (`path`, `properties`, `title`, `meta`, `action`) instead of exposing consumer-defined class bags.
- Static versus collapsible cards remain visibly consistent through one token source, while their interaction semantics stay explicit in their owning components.
- The full Work Item hook exposes `loading / ready / error` rather than conflating missing data with loading.
- Standalone items remain readable but do not expose non-functional edit controls.
- Project-scoped items expose compact shared property pills; the full property editor remains available through the canonical Work Item surface.

## Layer 8 — Wire protocol and serialization

- No new wire format was introduced.
- The extracted presentation primitives are stateless and introduce no new IPC, persistence, cache, subscription, timer, or request lifecycle.
- The start request is process-local transient UI state; it never enters tab persistence, project persistence, IPC, or the Agent wire payload.
- Work Item writes reuse the existing `WorkItemPartialUpdate` contract.
- To-Do drafts never cross that boundary; only normalized committed rows are serialized.
- Team/shared `+/-` impact is not synthesized: Kanban continues to consume authoritative local impact and cloud session metadata only.

## Layer 9 — Init parity

- No Agent initialization entry point changed. The request terminates at the same `handleStartAgent` used by the existing Work Item button.
- Manual refresh uses the same production local roster coordinator and cloud remote-session hook used by initial demand/realtime recovery.
- Tests call the source-composition helper only; rendered acceptance must still drive the real button.

## Layer 10 — Resolver symmetry

- Project-scoped reads resolve Work Item plus project metadata/repo identity; standalone reads use the standalone API and stay read-only.
- Local and cloud Kanban sources are both invoked by the manual action, while each source preserves its own scope/identity rules.
- Existing Session tabs are focused; missing tabs are created through the same open-or-focus atom for both Session cards and mention navigation.
- Work Item action resolution is symmetric for newly created and already-open tabs: both are activated first, then receive the same keyed one-shot request.

## Completion verdict

- One persistent Work Item owner, one Agent start dispatcher, one Session-tab dispatcher, and one cache owner per Kanban source.
- The Team Inbox navigation wrapper now forwards explicit child intents, so Session cards no longer collapse back to the selected row's generic Work Item destination.
- Stale Work Item reads are cancelled on selection change; overlapping writes use a monotonic generation before replacing UI state.
- Manual workflow refresh preserves the currently rendered Work Item on read failure and exposes the error banner; it does not replace success data with a transient empty state.
- Architecture verdict: pass for Layers 1–10 in the changed scope.
