# Canonical conversation continuation

This document records the current continuation contract. A conversation is a
single canonical event history that can be resumed by any supported native
runtime. Switching runtime is not a fork and does not flatten history into a
prompt.

## Authority and projection

- `SessionEvent[]` is the provider-neutral authority for roles, completed tool
  call/result pairs, images, compaction summaries, delivery state and sender
  provenance.
- Codex and Claude Code histories are projections of that authority into each
  provider's native role/tool transcript format.
- A target provider receives the complete verified canonical prefix as native
  messages. The new user turn is delivered once through the provider's normal
  send path.
- Provider-private reasoning and policy are not portable. Interrupted turns
  retain the accepted user event, completed assistant output and closed tool
  pairs; unresolved tool calls are not projected into another provider.
- Round-trip parsing must reproduce the same portable semantic items before a
  materialization can be used.

## Identity and runtime switching

- A canonical root identifies the conversation independently of any execution
  episode.
- Each compatible runtime/account/workspace binding may keep its own native
  UUID. Switching `Codex -> Claude Code -> Codex` synchronizes only the missing
  canonical suffix and reuses the earlier Codex UUID when it is still valid.
- The normal New Session runtime/model selectors choose the next target. No
  continuation-only workspace dialog or model registry exists.
- Native transcripts and the provider application catalog are published as one
  lifecycle. A native-format JSONL file alone is not advertised as visible in
  Codex or Claude Desktop.

## Delivery and concurrency

- `messageQueueAtom` is the only durable client dispatcher for ordinary sends,
  imported histories, My Sessions and Team Sessions.
- A queued row owns one stable `turnIntentId` across optimistic display,
  provider acceptance, restart recovery and Cloud publication.
- The existing queue FSM owns queued/preparing/accepted state, retry deadlines,
  Stop/Send Now behavior and follow-up ordering. Continuation code does not add
  a second wake counter, queue, footer FSM or scroll/follow implementation.
- A Web Lock only prevents two webviews on the same app instance from mutating
  one canonical root concurrently. For a backend that advertises
  `conversationTurnCoordination`, Cloud additionally admits Agent-directed
  turns into a per-canonical-root FIFO and lets the author's device claim only
  the head. The claim lease is renewed while the local provider run proceeds.
- A `claimed` turn whose lease expires before provider acceptance may be
  reclaimed. Immediately before provider dispatch, the owner marks the turn
  `accepted`; accepted ownership cannot move to another device. A renewal
  failure after that point therefore fails closed instead of causing a second
  provider run, and the accepting device must recover publication/finalization.
- Backends without the capability keep the existing idempotent event push/list
  workflow. The client does not call coordination RPCs or add a fallback
  dispatcher, poller, or watcher.
- Failed outgoing messages remain visible with their original body, images and
  mentions and can be retried or edited. Pre-send validation failures leave the
  composer unchanged.

## Team Sessions and Team Chat

- Cloud stores the shared canonical event plane and assigns a monotonic
  per-conversation sequence under the existing advisory lock.
- Push idempotency is `(org, root, turnIntentId, event.id)`. The Cloud never
  receives a user's provider key and does not execute a native runtime.
- Human Team Chat comments are canonical user-role events with structured
  sender provenance. `@member` and `@all` determine human notification audience;
  they do not create a second transcript.
- Agent reports remain non-portable system cards.
- The event plane remains multi-writer for durable transcript publication.
  Capability-gated turn coordination orders Agent execution per root without
  turning Cloud into an execution host; Team Chat remains outside that claim
  lifecycle.

## Context exhaustion

- Compaction is triggered only after the provider reports context exhaustion.
- If the accepted attempt has no replay-unsafe tool or assistant side effects,
  the provider may use its native compact/rollover capability.
- Otherwise ORG2 creates a fresh native episode from the structured canonical
  role/tool list and retries the accepted user turn once. It never works around
  exhaustion by embedding the transcript in one user prompt.
- The new native UUID remains attached to the same canonical root.

## Surface adapters

- My Session, imported history and Team Session surfaces provide only root
  identity, event loading/publication and target selection.
- Work Item comments may trigger this mechanism in the future, but Work Item
  code must remain a thin adapter and cannot own continuation, queue or provider
  materialization semantics.
