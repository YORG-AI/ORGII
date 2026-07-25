# ORG2 tree / progress mind map / Feishu channel report — 2026-07-25

## Scope and decisions

- **Context Lens is canceled / superseded.** No proxy, context capture, composition agent, or context-composition UI was added. `docs/frontend-ui-audit-2026-07-24/ContextLens.md` records the cancellation and points to deterministic persisted-data navigation instead.
- Kept the current information architecture local to the sidebar and selected Session chat surface. No dependency/runtime upgrades and no new graph dependency.

## Four-level sidebar tree

Corrected the existing hierarchy from `Workspace → Project → Task → Session` to the required exact order:

`Workspace → Project → Session → Task`

Changes:
- count badges on Workspace / Project;
- persisted status dot on Session;
- recursive selected-ancestor detection and auto-expansion for all four levels;
- connector lines, depth indentation, hover/selected states;
- native `title` for truncated long labels;
- existing recursive menu/row pipeline retained, so it remains compatible with existing sidebar list rendering rather than introducing a parallel tree widget;
- Session keeps the normal session id/action semantics; Task is a fourth-level detail leaf.

## Deterministic Progress Mind Map

Added a collapsible Session header panel driven only by `loadTurnIndex(sessionId)`, persisted `TurnSummary.modifiedFiles`, event counts/status/duration, and real `parentSessionId` child-session records.

Supports:
- main progress line and child-session fork nodes/edges;
- status dots and selected node details (events, duration, file paths);
- click-to-jump through the existing ChatHistory minimap/virtual `scrollToIndex` path;
- loading, error, empty and refresh states;
- large-session protection: newest 18 steps plus an aggregate node, with explicit show-all/collapse;
- no LLM call on open, no semantic fabrication, no added graph package.

Note: the current Session schema persists parent session but not an exact parent-turn foreign key, so fork edges use real child creation timestamps to select the nearest preceding persisted turn; legacy records without usable timestamps deterministically anchor to the latest turn. This limitation is explicit instead of guessed from text.

## Feishu channel diagnosis and minimal repair

### Read-only findings

Inspected `~/.orgii/settings.jsonc`, `credentials.json`, `integrations.json`, both ORG2 processes, and `~/.orgii/logs/orgii.log.2026-07-24` without printing credentials.

Confirmed:
- Feishu account was enabled and direct WebSocket reached `WebSocket connected`;
- a real inbound Feishu event was received and normalized;
- tenant access-token request succeeds;
- bot probe `/bot/v3/info` succeeds;
- IM chat probe `/im/v1/chats?page_size=1` succeeds;
- inbound event reached the gateway reinjection path.

Root cause from logs:
1. `integrations.json` had **no `channels.gateway` account/model binding**, so the inbound chain failed with `no selected_model_id after resolve`.
2. Error handling then created an outbound message for the internal pseudo-channel `gateway-reinject`, causing `Channel gateway-reinject not found`; therefore the user never saw the actionable model error.
3. Two ORG2 GUI processes were concurrently running the same installed binary and both started Feishu WebSocket/channel workers. This can duplicate subscriptions/processing and must be reduced to one process by the user/desktop owner before an end-to-end inbound test.

### Applied

- Backed up config before changing it: `~/.orgii/integrations.json.bak-20260725-004405-before-gateway-binding`.
- Added the minimal `channels.gateway` binding using an already configured local ORG2 account/model; no OpenClaw secret was copied and no secret entered Git.
- Fixed gateway error response routing to use the original transport/chat metadata (`feishu`) instead of `gateway-reinject`; added a focused Rust regression test.

### Verification status

- Token + bot + IM API probes: **PASS**.
- Direct WebSocket startup in current process logs: **PASS**.
- Real inbound event reception: **PASS (observed before binding fix)**.
- Gateway model binding now present: **PASS (configuration shape)**.
- Final real Feishu inbound → model → outbound message after fix: **NOT CLAIMED**. Installed ORG2 was not restarted because the new Rust binary could not be produced on the host without system GLib/WebKit development packages; restarting the old binary would not include the routing fix. Also two GUI processes require deliberate desktop cleanup. No OpenClaw Gateway process was touched.
- Feishu platform permission/event gap: no missing token/bot/chat-read permission was found by probes. Existing WebSocket event reception proves long-connection subscription is active. Sending still requires the app to retain normal bot message-send scope (`im:message` / bot send-message capability); this was not falsely asserted via an unsolicited test message.

## Validation

- Focused Vitest: **3 files / 17 tests passed** (tree, graph selector, existing chat minimap).
- ESLint on all touched frontend files: **PASS**.
- Frontend production webpack build: **PASS**, 332 files emitted to `/tmp/org2-frontend-build-20260725` (the repository `build/` is root-owned, so a temporary output path was used without changing source config).
- TypeScript full `tsc --noEmit`: completed with pre-existing quota type errors in `useLocalKeys.ts` and `refreshAccountModels.ts`; grep found no errors in changed tree/mind-map files.
- Native host Cargo test/check/build: blocked by absent system `glib-2.0.pc`; not an application-code error.
- Docker `cargo check -p agent_core` in the existing `orgii-build:22.04` image: **PASS** (warnings only). The focused Rust test was added, but its separate test-profile build was stopped after the check had already validated the changed crate; frontend/Rust source regression coverage remains in-tree.
- `git diff --check`: **PASS**.

## Operational next step

After the Docker release binary is available, back up the installed binary, close the duplicate ORG2 process, install the new binary, start exactly one ORG2 process, then send one Feishu DM and verify these ordered log markers: inbound parsed → gateway reinject → model resolution → outbound route `feishu` → successful delivery. Do not touch OpenClaw Gateway.
