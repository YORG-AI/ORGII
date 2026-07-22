/**
 * Fork-relay completion layer (design §16.11, "fork & continue").
 *
 * `collabSyncEngineHelpers.forkSession` lands a teammate's replayable history
 * as a writable local session (fresh `agentsession-*` id, `forkedFrom`
 * provenance, events durably cached). That record alone is not yet a working
 * relay — two gaps remain, both closed here:
 *
 * 1. **Dispatchability + durability.** The Rust side has no builtin prefix
 *    mapping for `agentsession-*` (agent-core `BUILTIN_PREFIX_REGISTRY` knows
 *    only `osagent-`/`sdeagent-`/`wingman-`), so the lazy `init_session` on
 *    the first `agent_send_message` can resolve an agent definition ONLY from
 *    a persisted `agent_sessions.agent_definition_id`. Without a backend row
 *    the first send fails ("no persisted agent_definition_id and no builtin
 *    prefix mapping"), and the TS-only session row is wiped by the next full
 *    `loadSessions()` list replace. `forkTeammateSession` therefore registers
 *    a real `agent_sessions` row via the existing `agent_save_session`
 *    command (definition `builtin:sde`, the fork's workspace path) — making
 *    the fork runnable and list-refresh-proof with zero Rust changes.
 *
 * 2. **LLM context continuity.** The agent's conversation context is rebuilt
 *    from `agent_messages` (`load_llm_history`), NOT from the display event
 *    cache the fork inherited — a fork starts with an empty message table, so
 *    without help the agent is blind to the teammate's context. There is no
 *    Tauri command to seed `agent_messages`, so the handoff rides the FIRST
 *    message instead: the bounded Rust snapshot ingest returns at most 80
 *    compact handoff items, which are stored with the relay marker.
 *    `buildPendingForkHandoff` wraps the user's first send from those items
 *    without re-reading the inherited event cache, while `displayText` keeps
 *    the user's own words in the transcript. The handoff is one-shot and
 *    durable across restarts (localStorage registry), consumed by
 *    `markForkHandoffConsumed` only after the send succeeds.
 *
 * The registry doubles as durable provenance: backend list reloads rebuild
 * `Session` rows from Rust (which does not know `forkedFrom`), so
 * `getSessionForkedFrom` falls back to the registry when the row field is
 * gone — "⑂ taken over from @owner" survives reloads.
 */
import { exists } from "@tauri-apps/plugin-fs";
import { z } from "zod/v4";

import { deleteSession, saveSession } from "@src/api/tauri/agent";
import type { SessionMeta } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import i18n from "@src/i18n";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { reposAtom } from "@src/store/repo";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { removeSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionForkedFrom,
} from "@src/store/session/sessionAtom/types";
import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { toFsPluginPath } from "@src/util/file/pathUtils";

import { normalizeRepoScopeKey } from "./collabSyncUtils";
import { forkCheckoutRequestAtom } from "./components/ForkCheckoutPickerDialog";
import {
  type ForkSessionSetupSelection,
  forkSessionSetupRequestAtom,
} from "./components/ForkSessionSetupDialog";
import type {
  ForkExecutionSelection,
  ForkSessionOptions,
  ForkSessionResult,
} from "./engine/collabSyncEngineHelpers";
import { forkSession } from "./engine/collabSyncEngineHelpers";
import { ForkOperationError } from "./forkSnapshotIntegrity";
import {
  resolveLocalCheckoutForScopeKey,
  resolveMatchingOrgRepoScope,
  resolveShareableScopeKeys,
} from "./repoScopeResolver";
import {
  cloudOrgToken,
  sessionOrgTagsAtom,
  withTag,
} from "./sessionOrgTagsAtom";

export type { ForkSessionResult };

// ============================================================================
// Durable fork-relay registry (provenance + one-shot handoff marker)
// ============================================================================

const FORK_RELAY_STORAGE_KEY = "orgii:collabForkRelay:v1";

/** Registry size cap — evicts the oldest fork (by forkedAt) past this. */
const MAX_REGISTRY_ENTRIES = 100;
const MAX_HANDOFF_ITEMS = 80;
const MAX_ITEM_TEXT_LENGTH = 1200;

const SessionForkedFromSchema = z.object({
  orgId: z.string(),
  sourceSessionId: z.string(),
  ownerMemberId: z.string(),
  ownerDisplayName: z.string(),
  atCount: z.number(),
  forkedAt: z.string(),
  rootSessionId: z.string().optional(),
}) satisfies z.ZodType<SessionForkedFrom>;

const ForkRelayEntrySchema = z.object({
  forkedFrom: SessionForkedFromSchema,
  /** True until the first successful message send consumes the handoff. */
  handoffPending: z.boolean(),
  /** Bounded, pre-folded context produced while the remote snapshot streams. */
  handoffItems: z
    .array(z.string().max(MAX_ITEM_TEXT_LENGTH))
    .max(MAX_HANDOFF_ITEMS)
    .optional(),
});

type ForkRelayEntry = z.output<typeof ForkRelayEntrySchema>;

const ForkRelayRegistrySchema = z.record(z.string(), ForkRelayEntrySchema);

type ForkRelayRegistry = z.output<typeof ForkRelayRegistrySchema>;

function readRegistry(): ForkRelayRegistry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(FORK_RELAY_STORAGE_KEY);
    if (!raw) return {};
    return ForkRelayRegistrySchema.parse(JSON.parse(raw));
  } catch {
    // Corrupt / legacy payload: fork provenance is a convenience, never a
    // reason to break the fork flow itself.
    return {};
  }
}

function writeRegistry(registry: ForkRelayRegistry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FORK_RELAY_STORAGE_KEY, JSON.stringify(registry));
  } catch {
    // Quota exceeded — same silent posture as the session list persistence.
  }
}

function writeRegistryEntry(sessionId: string, entry: ForkRelayEntry): void {
  const registry = readRegistry();
  registry[sessionId] = entry;
  const ids = Object.keys(registry);
  if (ids.length > MAX_REGISTRY_ENTRIES) {
    const oldestFirst = ids.sort((left, right) =>
      registry[left].forkedFrom.forkedAt.localeCompare(
        registry[right].forkedFrom.forkedAt
      )
    );
    for (const id of oldestFirst.slice(0, ids.length - MAX_REGISTRY_ENTRIES)) {
      delete registry[id];
    }
  }
  writeRegistry(registry);
}

export function removeForkRelayEntry(sessionId: string): void {
  const registry = readRegistry();
  if (!(sessionId in registry)) return;
  delete registry[sessionId];
  writeRegistry(registry);
}

/**
 * Fork provenance for a session row — the read API for "⑂ taken over from
 * @owner" badges. Prefers the live `Session.forkedFrom` field and falls back
 * to the durable registry (list reloads rebuild rows from the backend, which
 * does not know the field).
 */
export function getSessionForkedFrom(
  session: Pick<Session, "session_id" | "forkedFrom">
): SessionForkedFrom | undefined {
  return session.forkedFrom ?? readRegistry()[session.session_id]?.forkedFrom;
}

// ============================================================================
// The full fork action (engine fork + backend registration + relay arming)
// ============================================================================

/**
 * Fork workspace resolution (fork-relay repoPath fix): the remote record's
 * `repoPath` is the OWNER's absolute path — on this machine it usually does
 * not exist, and an agent dispatched into it would run in a bogus
 * workspace. Resolve a LOCAL checkout instead, via the SAME resolver chain
 * scope-matching uses (`resolveShareableScopeKey` under
 * `resolveLocalCheckoutForScopeKey`), probing every locally-known repo path
 * (repo store + local sessions' workspaces) against the record's
 * cross-machine `repoScopeKey`. Fallback: when the owner's path IS one of
 * our known local paths (same-machine fork, or a repo with no git remote),
 * keep it. Returns null when nothing matches — the fork then opens WITHOUT
 * a workspace (plus a non-blocking hint) rather than with a dead foreign
 * path.
 *
 * Exported so every fork entry point shares the same workspace resolver.
 */
export async function resolveForkWorkspacePath(
  remoteSession: RemoteTeammateSessionMetadata
): Promise<string | null> {
  // No store yet (early boot edge) ⇒ no candidates to match against.
  if (!isStoreInitialized()) return null;
  const store = getInstrumentedStore();
  const candidates: string[] = [];
  for (const repo of store.get(reposAtom)) {
    if (repo.path) candidates.push(repo.path);
  }
  for (const session of store.get(sessionsAtom) as Session[]) {
    if (session.repoPath) candidates.push(session.repoPath);
  }

  // Repo/session atoms may retain another machine's absolute path after a
  // cloud import. Only paths that exist on THIS machine may participate in
  // scope resolution or the same-machine fallback.
  const existingCandidates: string[] = [];
  const seenCandidates = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeRepoScopeKey(candidate);
    if (!normalized || seenCandidates.has(normalized)) continue;
    seenCandidates.add(normalized);
    try {
      if (await exists(toFsPluginPath(candidate))) {
        existingCandidates.push(candidate);
      }
    } catch {
      // Invalid/stale paths fail closed; a later valid checkout can still win.
    }
  }

  const byScopeKey = await resolveLocalCheckoutForScopeKey(
    remoteSession.repoScopeKey,
    existingCandidates
  );
  if (byScopeKey) return byScopeKey;

  // Same-machine fallback: exact path identity against our known local
  // paths proves the checkout exists here even when there is no scope key
  // to match (repo without a git remote) or remote resolution hiccuped.
  if (remoteSession.repoPath) {
    const normalizedOwnerPath = normalizeRepoScopeKey(remoteSession.repoPath);
    if (
      normalizedOwnerPath &&
      existingCandidates.some(
        (candidate) => normalizeRepoScopeKey(candidate) === normalizedOwnerPath
      )
    ) {
      return normalizedOwnerPath;
    }
  }
  return null;
}

export interface ForkTeammateSessionOptions extends ForkSessionOptions {
  /** User-initiated forks open one setup dialog before any remote fetch. */
  promptForExecution?: boolean;
  /** Pre-resolved execution choice for headless/programmatic callers. */
  execution?: ForkExecutionSelection;
  /**
   * Workspace override with KEY-PRESENCE semantics (agent-pickup design §4),
   * mirroring the engine's `ForkSessionOptions.workspaceRepoPath`:
   * - key ABSENT ⇒ resolve a local checkout via `resolveForkWorkspacePath`
   *   (the default relay behavior, unchanged);
   * - key present with a path ⇒ use it verbatim (the runner dialog's
   *   pick-a-folder choice — the user already confirmed it);
   * - key present with undefined/null ⇒ fork WITHOUT a workspace (the
   *   runner's explicit "run without workspace" choice — no resolver probe
   *   and no "no local checkout" hint, since the user already decided).
   */
  workspaceRepoPath?: string | null;
}

export interface ForkSessionSetupSource {
  sourceTitle: string;
  sourceScopeKey?: string;
  sourceModel?: string;
  sourceAgentDisplayName?: string;
  sourceAgentDefinitionId?: string;
}

/**
 * Shared local execution picker for every read-only history continuation —
 * cloud teammate replays and local Codex/Claude/Cursor histories alike.
 * Keeping the prompt + remote verification here prevents each source adapter
 * from inventing its own workspace/account/model fallback chain.
 */
export async function requestForkSessionSetup(
  source: ForkSessionSetupSource
): Promise<ForkSessionSetupSelection> {
  if (!isStoreInitialized()) throw new ForkCancelledError();
  const store = getInstrumentedStore();
  const selected = await new Promise<ForkSessionSetupSelection | null>(
    (resolve) => {
      store.set(forkSessionSetupRequestAtom, {
        sourceTitle: source.sourceTitle,
        sourceScopeKey: source.sourceScopeKey,
        sourceModel: source.sourceModel,
        sourceAgentDisplayName: source.sourceAgentDisplayName,
        sourceAgentDefinitionId: source.sourceAgentDefinitionId,
        resolve,
      });
    }
  );
  if (!selected) throw new ForkCancelledError();
  if (source.sourceScopeKey) {
    if (!selected.workspaceRepoPath) throw new ForkCancelledError();
    const normalizedKey = normalizeRepoScopeKey(source.sourceScopeKey);
    const keys = await resolveShareableScopeKeys(selected.workspaceRepoPath);
    const matchingScope = await resolveMatchingOrgRepoScope(keys, [
      normalizedKey,
    ]);
    if (!matchingScope) {
      Message.error(
        i18n.t("navigation:collaboration.session.forkCheckoutMismatch", {
          repo: source.sourceScopeKey,
          session: source.sourceTitle,
        })
      );
      throw new ForkCancelledError();
    }
  }
  return selected;
}

async function pickForkSessionSetup(
  remoteSession: RemoteTeammateSessionMetadata
): Promise<ForkSessionSetupSelection> {
  return requestForkSessionSetup({
    sourceTitle: remoteSession.title,
    sourceScopeKey: remoteSession.repoScopeKey,
    sourceModel: remoteSession.model,
    sourceAgentDisplayName: remoteSession.agentDisplayName,
    sourceAgentDefinitionId: remoteSession.agentDefinitionId,
  });
}

/**
 * THE fork-and-continue action for the collab panel (design §16.11). Wraps
 * the engine-level `forkSession` (which lands the events + TS session record)
 * and completes the relay:
 *
 * 1. resolves a LOCAL workspace for the fork (see
 *    `resolveForkWorkspacePath`) — never the owner's absolute path — unless
 *    the caller pre-decided one via the `workspaceRepoPath` override;
 * 2. registers the real `agent_sessions` backend row (`agent_save_session`)
 *    so the fork is dispatchable (definition resolution) and survives full
 *    session-list reloads;
 * 3. records durable provenance and arms the one-shot first-send handoff;
 * 4. CLOUD orgs only: auto-tags the fork back to the source cloud org
 *    (`sessionOrgTagsAtom`), so the forker's continuation pushes back to
 *    the org regardless of whether their local repo resolves into the
 *    org's repo scopes — closing the "owner never sees the continuation"
 *    relay gap. (Tagged pushes bypass scope in Org2CloudSyncEngine; the
 *    access ladder still applies — an effective-off fork pushes at
 *    metadata_only.) Self-hosted orgs are deliberately NOT tagged: the
 *    self-hosted CollabSyncEngine does not consume org tags for push
 *    eligibility, so a tag would be a silent no-op — there the residual
 *    remains that a continuation only reaches the org when the forker's
 *    local repo matches the org's repo scopes.
 *
 * Returns null exactly when `forkSession` does (no published segments);
 * THROWS when the backend registration fails — the fork would look fine in
 * the list but break on the first send, so the caller must surface it as a
 * failed (retryable) fork instead.
 */
/**
 * Thrown when the user dismisses the mandatory pick-your-checkout dialog (or
 * picks a folder that is not a checkout of the source repo). Callers treat it
 * as a quiet cancel — no "fork failed" toast.
 */
export class ForkCancelledError extends Error {
  constructor() {
    super("fork cancelled: no matching local checkout selected");
    this.name = "ForkCancelledError";
  }
}

/**
 * Mandatory checkout selection (strict scope governance): a fork continues
 * the SOURCE repo's work and can only sync back to the org from a local
 * checkout of that repo — a workspace-less fork would be permanently
 * unable to push (scope resolution yields nothing) and the owner would
 * never see the continuation. So when the resolver finds no checkout, open
 * the IN-APP ForkCheckoutPickerDialog (workspace repo list; only rows whose
 * remotes match the source repo are selectable) and VERIFY the pick's git
 * remotes before proceeding. Cancel / mismatch aborts the fork
 * (ForkCancelledError).
 */
async function pickMatchingCheckout(
  sourceScopeKey: string,
  sourceTitle: string
): Promise<string> {
  if (!isStoreInitialized()) throw new ForkCancelledError();
  const store = getInstrumentedStore();
  const selected = await new Promise<string | null>((resolve) => {
    store.set(forkCheckoutRequestAtom, {
      sourceScopeKey,
      sourceTitle,
      resolve,
    });
  });
  if (!selected) {
    throw new ForkCancelledError();
  }
  // Defense-in-depth: re-verify the picked checkout's remotes really include
  // the source repo (the dialog already filters, but the repo may have been
  // re-pointed since its cache entry).
  const normalizedKey = normalizeRepoScopeKey(sourceScopeKey);
  const keys = await resolveShareableScopeKeys(selected);
  const matchingScope = await resolveMatchingOrgRepoScope(keys, [
    normalizedKey,
  ]);
  if (!matchingScope) {
    Message.error(
      i18n.t("navigation:collaboration.session.forkCheckoutMismatch", {
        repo: sourceScopeKey,
        session: sourceTitle,
      })
    );
    throw new ForkCancelledError();
  }
  return selected;
}

export async function forkTeammateSession(
  options: ForkTeammateSessionOptions
): Promise<ForkSessionResult | null> {
  // KEY-PRESENCE check, not a `??` default: an explicitly-passed
  // undefined/null means "fork WITHOUT a workspace"; only a fully absent key
  // falls back to the resolver. The runner's pre-flight workspace confirm
  // depends on this distinction (its dialog choices map 1:1 onto the two
  // present-key shapes).
  let hasWorkspaceOverride = "workspaceRepoPath" in options;
  let workspaceRepoPath: string | null;
  let execution = options.execution;
  if (options.promptForExecution) {
    const setup = await pickForkSessionSetup(options.remoteSession);
    workspaceRepoPath = setup.workspaceRepoPath;
    execution = setup.execution;
    hasWorkspaceOverride = true;
  } else if (hasWorkspaceOverride) {
    workspaceRepoPath = options.workspaceRepoPath ?? null;
  } else if (options.remoteSession.repoScopeKey) {
    // A repo-scoped fork is a governance decision, not merely a path
    // fallback. Always make the user explicitly choose the local checkout
    // that will own the continuation, even when the resolver already knows a
    // matching repo. The picker filters and re-verifies remotes, so SEND can
    // never silently infer fork eligibility from stale repo/session state.
    workspaceRepoPath = await pickMatchingCheckout(
      options.remoteSession.repoScopeKey,
      options.remoteSession.title
    );
  } else {
    workspaceRepoPath = await resolveForkWorkspacePath(options.remoteSession);
  }
  // A headless caller must provide the same explicit local execution choice
  // as the setup dialog. Never resurrect the old implicit builtin:sde path.
  if (!execution?.agentDefinitionId) {
    throw new ForkOperationError(
      "agent_unavailable",
      options.remoteSession.sourceSessionId,
      "No local agent was selected for this fork"
    );
  }
  const { promptForExecution: _prompt, ...fetchOptions } = options;
  const result = await forkSession({
    ...fetchOptions,
    workspaceRepoPath,
    execution,
  });
  if (!result) return null;

  if (result.modelFallback) {
    const { inheritedModel, fallbackModel } = result.modelFallback;
    Message.info(
      fallbackModel
        ? i18n.t("navigation:collaboration.session.forkModelFallback", {
            model: inheritedModel,
            fallback: fallbackModel,
          })
        : i18n.t("navigation:collaboration.session.forkModelUnavailable", {
            model: inheritedModel,
          })
    );
  }

  const { orgId, remoteSession } = options;
  const now = new Date().toISOString();

  // UnifiedSessionRecord requires `session_type`; SessionMeta's zod input
  // schema passes unknown keys through (catchall), so the extra field
  // reaches the Rust record intact. "sde" = coding session (session_type
  // module in agent-core), matching the builtin:sde definition below.
  const backendRecord = {
    sessionId: result.localSessionId,
    name: result.name,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    workspacePath: workspaceRepoPath ?? undefined,
    model: result.model,
    accountId: result.accountId,
    // Preserve the collaboration filing in Rust too. Without this, the
    // backend defaults the durable row to `personal-org`; the next
    // loadSessions() then moves a cloud fork out of its Team sidebar even
    // though the optimistic TS row and cloud tag still point at the source
    // org. Guest-share forks deliberately remain Personal.
    orgId: options.shareToken ? undefined : orgId,
    // agentsession-* has no builtin prefix mapping in agent-core, so the
    // explicitly confirmed LOCAL definition id is the lazy-init authority.
    // The source's wire id is only a picker hint and is never trusted here.
    agentDefinitionId: execution.agentDefinitionId,
    sessionType: "sde",
  } as SessionMeta;
  try {
    await saveSession(backendRecord);
  } catch (error) {
    // The engine writes inherited events + the optimistic TS row first. A
    // failed backend registration would otherwise leave a visible fork that
    // can never dispatch. Roll every local artifact back before surfacing the
    // retryable failure; backend delete is defensive if save failed late.
    await deleteSession(result.localSessionId).catch(() => undefined);
    await eventStoreProxy.clear(result.localSessionId).catch(() => undefined);
    removeSession(result.localSessionId);
    if (isStoreInitialized()) {
      const store = getInstrumentedStore();
      persistSessions(store.get(sessionsAtom) as Session[]);
    }
    throw new ForkOperationError(
      "backend_registration",
      remoteSession.sourceSessionId,
      "Failed to register the forked session backend",
      error
    );
  }

  writeRegistryEntry(result.localSessionId, {
    forkedFrom: {
      orgId,
      sourceSessionId: remoteSession.sourceSessionId,
      ownerMemberId: remoteSession.ownerMemberId,
      ownerDisplayName: remoteSession.ownerDisplayName,
      atCount: result.eventCount,
      forkedAt: now,
      // Root inheritance MUST survive here too: pushes restore lineage from
      // THIS registry entry (the Session row's forkedFrom is stripped by the
      // first loadSessions()), so omitting rootSessionId degrades the wire
      // root to the direct parent and splinters the fork thread.
      rootSessionId:
        remoteSession.forkedFrom?.rootSessionId ??
        remoteSession.sourceSessionId,
    },
    handoffPending: true,
    handoffItems: result.handoffItems
      .slice(-MAX_HANDOFF_ITEMS)
      .map(truncateText),
  });

  if (isStoreInitialized()) {
    const store = getInstrumentedStore();
    // Auto-tag CLOUD forks back to their source org (see docblock item 4).
    // Cloud-vs-self-hosted follows from org id membership alone — the two
    // id namespaces never merge (org2CloudOrgsAtom isolation note).
    const isCloudOrg = store
      .get(org2CloudOrgsAtom)
      .some((org) => org.orgId === orgId);
    if (isCloudOrg && !options.shareToken) {
      store.set(sessionOrgTagsAtom, (current) =>
        withTag(current, result.localSessionId, cloudOrgToken(orgId))
      );
    }
    if (workspaceRepoPath === null && !hasWorkspaceOverride) {
      // Non-blocking: the fork opened fine, it just has no workspace until
      // the user clones the repo / picks one manually. Suppressed for
      // explicit overrides — a caller that PASSED "no workspace" (the
      // runner's confirmed dialog choice) already knows.
      Message.info(
        i18n.t("navigation:collaboration.session.forkNoLocalCheckout")
      );
    }
  }

  return result;
}

// ============================================================================
// First-send handoff (LLM context continuity)
// ============================================================================

function textValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    const parts = value.map(textValue).filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      textValue(record.text) ??
      textValue(record.content) ??
      textValue(record.message) ??
      textValue(record.output) ??
      textValue(record.observation) ??
      textValue(record.summary)
    );
  }
  return undefined;
}

function truncateText(text: string): string {
  return text.length > MAX_ITEM_TEXT_LENGTH
    ? `${text.slice(0, MAX_ITEM_TEXT_LENGTH - 1)}…`
    : text;
}

function eventToHandoffItem(event: SessionEvent): string | undefined {
  const actionType = event.actionType ?? "";
  // Thinking is the owner's model-internal state — never part of a handoff
  // (same rule as the Codex external-history fork).
  if (actionType.includes("thinking") || actionType.includes("reasoning")) {
    return undefined;
  }

  const primary =
    (event.displayText || "").trim() ||
    textValue(event.result) ||
    textValue(event.args);

  if (event.source === "user") {
    return primary ? `User: ${truncateText(primary)}` : undefined;
  }
  if (actionType === "tool_call" || actionType.includes("tool")) {
    const lines = [
      "[Inherited session action]",
      `Tool: ${event.functionName || "unknown_tool"}`,
    ];
    const argsText = textValue(event.args);
    const resultText = textValue(event.result);
    if (argsText) lines.push(`Input: ${truncateText(argsText)}`);
    if (resultText)
      lines.push(`Result at that time: ${truncateText(resultText)}`);
    return lines.join("\n");
  }
  return primary ? `Assistant: ${truncateText(primary)}` : undefined;
}

function buildForkHandoffPromptFromItems(
  handoffItems: readonly string[],
  forkedFrom: SessionForkedFrom,
  userText: string
): string {
  const items = handoffItems.slice(-MAX_HANDOFF_ITEMS).map(truncateText);

  return [
    "You are taking over a teammate's shared ORGII session and continuing it as your own session.",
    `Original owner: ${forkedFrom.ownerDisplayName}. The transcript below is the inherited history (${forkedFrom.atCount} events) from their machine, provided as read-only context.`,
    "Do not treat inherited tool calls as tools you executed or as current workspace state. Results may be stale; verify files, commands, and outcomes against the current workspace before relying on them.",
    "Thinking/reasoning items were intentionally omitted.",
    "",
    "## Inherited session context",
    items.length > 0
      ? items.join("\n\n")
      : "No usable transcript items were found.",
    "",
    "## Continuation request",
    userText,
  ].join("\n");
}

/** Exported for tests; assembles the wrapped first-send content. */
export function buildForkHandoffPrompt(
  events: SessionEvent[],
  forkedFrom: SessionForkedFrom,
  userText: string
): string {
  const items = events
    .map(eventToHandoffItem)
    .filter((item): item is string => Boolean(item));
  return buildForkHandoffPromptFromItems(items, forkedFrom, userText);
}

export interface ForkHandoffContent {
  /** Wire content for the LLM: handoff digest + the user's message. */
  content: string;
  /** What the transcript should show — the user's own words. */
  displayText: string;
}

/**
 * When `sessionId` is a fork whose handoff has not been consumed yet, build
 * the wrapped first-send content from the bounded digest saved at fork time.
 * It deliberately never hydrates the inherited event cache. Pure read — call
 * `markForkHandoffConsumed` after the send SUCCEEDS so a failed send retries
 * with the handoff intact. Returns null for every non-fork session and for
 * forks that already relayed their context.
 */
export async function buildPendingForkHandoff(
  sessionId: string,
  userText: string
): Promise<ForkHandoffContent | null> {
  const entry = readRegistry()[sessionId];
  if (!entry?.handoffPending) return null;

  return {
    content: buildForkHandoffPromptFromItems(
      entry.handoffItems ?? [],
      entry.forkedFrom,
      userText
    ),
    displayText: userText,
  };
}

/** Consume the one-shot handoff after the wrapped send succeeded. */
export function markForkHandoffConsumed(sessionId: string): void {
  const registry = readRegistry();
  const entry = registry[sessionId];
  if (!entry?.handoffPending) return;
  // Once consumed, drop the digest as well: provenance remains durable while
  // bounded context no longer spends localStorage quota indefinitely.
  registry[sessionId] = {
    ...entry,
    handoffPending: false,
    handoffItems: undefined,
  };
  writeRegistry(registry);
}

export const __FORK_RELAY_INTERNALS = {
  FORK_RELAY_STORAGE_KEY,
  MAX_REGISTRY_ENTRIES,
  MAX_HANDOFF_ITEMS,
  MAX_ITEM_TEXT_LENGTH,
};
