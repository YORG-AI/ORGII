# Conversation Events Plane — the real fix for "it's just one session"

2026-08-21. User directive: chatting in a conversation must NOT be a fork —
forks exist only behind the explicit Fork button. This design removes the
fork machinery from implicit continuation entirely by giving conversations
their own **multi-writer event plane** on the cloud, mirroring the proven
session-comments wire.

## Model

- A **conversation** is keyed by `(org_id, root_session_id)` — the family
  root's bare session id. It OUTLIVES the root session row (retention
  expiry of the oldest segment must never mute the conversation — observed
  live 2026-08-21 with ORG2_RETENTION_EXPIRED).
- The owner's own session transcript stays the base timeline (owner-only
  push unchanged) — AND every owner turn is ALSO published to the plane
  (user row at dispatch, agent tail at terminal, one turnId) under the
  local event ids, so the plane carries every turn of the conversation and
  its seq is the one total order. Clients fold plane rows onto their local
  twins (owner transcript, imported replay copies) by turn-intent id for
  user rows and by source event id for the rest; pre-plane history keeps
  the timestamp merge.
- Any other member's turn runs on THEIR machine (sender-runs/sender-pays)
  in a **local runner session** that is: created empty (external-history
  fork pattern — context injected, never copied), per-session sync OFF
  (never pushed as a session row), invisible in every session list.
- On turn completion the runner's new events are pushed to
  `cloud_conversation_events` with the author's identity; every client
  merges `owner transcript + conversation plane + discussion` into ONE
  stream (the merge/attribution/rendering pipeline from the fork-stitching
  work is reused verbatim — turn-plane events are normalized SessionEvents
  with a `conversationSender` stamp).
- Context continuity: EVERY send (owner included) prefixes the agent
  content with a rendered delta of conversation events the executing
  session has not yet seen (per-runner cursor). Display text stays the
  user's words; the delta rides agentContent (the projection contract from
  the external-history fork path).

## Cloud (migration 0024_conversation_events.sql)

- Table `cloud_conversation_events(id, org_id, root_session_id,
author_user_id, turn_id, seq, event jsonb, created_at)`.
  - `seq` server-assigned per conversation under
    `pg_advisory_xact_lock(hash(org_id, root_session_id))` (0015 pattern).
  - Event cap 64KB each, ≤200 events per push call; oversized payloads are
    truncated client-side before push with a marker.
  - No FK to cloud_sessions: the plane outlives the root row.
- Counters table `cloud_conversations(org_id, root_session_id, event_count,
prompt_count, last_event_at)` maintained under the same lock — feeds
  listing badges without count(\*) scans.
- RPCs (definer, RPC-only posture, org-membership asserted; visibility
  honors the root session's access ladder WHILE the row exists, falls back
  to org-wide once it ages out; read-time retention on event created_at —
  soft, Slack model):
  - `cloud_push_conversation_events(p_org_id, p_root_session_id, p_turn_id,
p_events jsonb[])` → `{firstSeq, lastSeq}`; batch-append so live
    streaming of a running turn is a client cadence choice, not a schema
    change.
  - `cloud_list_conversation_events(p_org_id, p_root_session_id,
p_after_seq, p_limit)` → ordered rows + authors.
- Signal: new kind `conversationEvents` via `nudge_org_signal` (dedicated
  trigger fn, 0015 precedent) + client presence-channel broadcast
  (comments-bus pattern) for sub-second delivery.
- `cloud_list_org_sessions`: additive per-row `conversationEventCount` /
  `conversationPromptCount` (joined from the counters table by
  root_session_id == sourceSessionId).
- `get_cloud_capabilities()` gains `conversationEvents: true` — the client
  feature gate; pre-plane backends keep the fork-wire fallback.
- GDPR: export includes authored events; account deletion removes them
  (cloud_session_comments precedent for personal content). Both functions
  recreated from their LATEST bodies (delete: 0016, export: 0003) with
  additive blocks.

## Client (ORGII)

1. Protocol: `org2CloudConversationEventsClient` + per-conversation atom
   (after_seq cursor, LWW merge), realtime bump on the `conversationEvents`
   signal kind + broadcast bus.
2. Read: ConversationStreamProvider merges plane events (author-stamped)
   after the base segments; dedup by turn against optimistic local copies.
3. Write: `conversation runner` — registry `rootSessionId → runner session`
   (per device); created via the continuation setup flow (setup memory
   applies, so no dialog after the first time anywhere in the org repo
   scope); per-session sync forced OFF; hidden from session lists.
   Turn watch = event-marker based (never bare terminal status — the
   stale-reply race), then push the turn's events.
4. Send routing (capability-gated): implicit sends in any conversation
   surface go to the runner+plane; the fork-before-send and tip-follow
   paths remain ONLY as the fallback for pre-plane backends. The explicit
   Fork button keeps real forking (a deliberate branch = a new
   conversation).
5. Unread: family badge adds conversationPromptCount to the aggregate;
   seen watermark unchanged (counts ride the same ratchet).

## Explicitly deferred

- Live streaming of in-flight turns to OTHER clients (plane supports it;
  client pushes at turn completion in v1). The sender's own surface overlays
  the runner's live events and scopes the working indicator to the runner.
- Migrating Team chat (comments) onto the same plane.
- Backfilling legacy fork families into planes (they keep the stitched
  read path indefinitely).
