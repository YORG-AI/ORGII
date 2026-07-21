/**
 * Fork & continue (design §16.11 — session relay).
 *
 * `forkSession` is the WRITABLE sibling of `importRemoteSession`
 * (`collabSessionImport.ts`): backend-agnostic, sharing the exact
 * fetch/assembly path (`fetchAndAssembleSegments`) and durable-write ordering,
 * differing only in the kind of local session the assembled events land in.
 */
import { DISPATCH_CATEGORY } from "@src/api/tauri/session/dispatchTypes";
import type { KeyInfo } from "@src/api/types/keys";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { loadSharedLocalKeys } from "@src/hooks/keyVault/sharedLocalKeyStore";
import { lastModelPairMapAtom } from "@src/store/session/creatorDefaultModelAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionForkedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  isModelRunnableWithAccount,
  resolveForkModel,
} from "../forkModelFallback";
import {
  FORK_SNAPSHOT_ERROR_KIND,
  ForkOperationError,
  ForkSnapshotIntegrityError,
} from "../forkSnapshotIntegrity";
import { rewriteEventsForImportedSnapshot } from "./collabImportIdentity";
import type { RemoteSessionFetchOptions } from "./collabRemoteFetch";
import { fetchAndAssembleSegments } from "./collabRemoteFetch";

/**
 * Fresh id for a forked session. The `agentsession-` prefix maps to the
 * `rust_agent` category in `SESSION_PREFIX_REGISTRY` — the SAME runnable
 * category a normal local agent session uses — and is deliberately NOT the
 * `imported-session-` prefix (read-only external history).
 */
export function createForkedSessionId(): string {
  return `agentsession-${crypto.randomUUID()}`;
}

/**
 * Locale-neutral fork marker for the forked session's display name.
 * Forking a fork must not stack markers ("⑂ ⑂ title") — one glyph carries
 * the provenance; the lineage chain lives in forkedFrom, not the name.
 */
export function buildForkedSessionName(sourceTitle: string): string {
  return `⑂ ${sourceTitle.replace(/^(?:⑂\s*)+/u, "")}`;
}

export interface ForkSessionResult {
  localSessionId: string;
  /** Display name persisted on the forked record (source title + ⑂ marker). */
  name: string;
  /** Events inherited from the source (== forkedFrom.atCount). */
  eventCount: number;
  /**
   * The workspace the fork actually landed in — a LOCAL checkout resolved
   * from the source's repoScopeKey when `workspaceRepoPath` was supplied,
   * else the owner's raw repoPath (legacy callers). undefined ⇒ the fork
   * opened without a workspace.
   */
  repoPath?: string;
  model?: string;
  accountId?: string;
  agentDefinitionId?: string;
  modelFallback?: { inheritedModel: string; fallbackModel?: string };
}

export interface ForkExecutionSelection {
  agentDefinitionId: string;
  accountId: string;
  model: string;
}

export interface ForkSessionOptions extends RemoteSessionFetchOptions {
  /** Explicit local credentials/model chosen by the member continuing it. */
  execution?: ForkExecutionSelection;
  /**
   * Fork workspace override (fork-relay repoPath fix): when the key is
   * PRESENT, the forked record's repoPath is this LOCAL checkout — or none
   * at all when null — instead of `remoteSession.repoPath`, which is the
   * OWNER's absolute path and generally does not exist on this machine
   * (an agent dispatched into it would run in a bogus workspace).
   * `forkTeammateSession` always passes this after resolving the source's
   * repoScopeKey against local checkouts.
   */
  workspaceRepoPath?: string | null;
}

/**
 * "Fork & continue" (design §16.11): land a replay-capable teammate session's
 * FULL event history as a new WRITABLE local session, so an agent can run on
 * this machine, with this member's key, continuing from the teammate's
 * context. NOT multi-writer — the fork is an ordinary single-writer session
 * that merely records its origin in `forkedFrom`.
 *
 * Shares the exact fetch/assembly path with `importRemoteSession`
 * (`fetchAndAssembleSegments`, always a full refetch from seq 0 — a fork has
 * no incremental cursor to splice onto) and mirrors its durable-write
 * ordering: events are cached BEFORE the session record is persisted, so a
 * failed cache write can never leave a forked record with no events (fix P7's
 * ordering, same rationale as the importer).
 *
 * Unlike an import, the created session:
 * - gets a fresh NORMAL id (`agentsession-*`, category `rust_agent`) so it is
 *   runnable and dispatchable;
 * - sets `forkedFrom` (provenance only) and NOT `importedFrom` — verified
 *   against `isSessionPushAllowed` (collabSyncUtils.ts), which excludes only
 *   `category === "external_history"` and `importedFrom`-bearing sessions:
 *   a fork has neither, so the member's continuation correctly syncs back to
 *   the org under their OWN member id, per their accessMode;
 * - carries `created_at = now`, so the `shareSince` "only new sessions" gate
 *   treats the fork as new work (it is — the inherited history was already
 *   shared by its owner).
 *
 * Permission is the source session's replay visibility (design §16.11): the
 * segments fetch succeeds only under FULL_REPLAY or a replay-level share —
 * enforced server-side, nothing new here. Returns null when the owner has
 * published no segments (metadata-only sessions have nothing to inherit);
 * THROWS on a failed durable write so callers surface it as retryable.
 */
export async function forkSession(
  options: ForkSessionOptions
): Promise<ForkSessionResult | null> {
  const { orgId, remoteSession, shareToken } = options;
  // Workspace choice: an explicit workspaceRepoPath (resolved local
  // checkout, possibly null = none) wins over the owner's absolute path.
  const repoPath =
    "workspaceRepoPath" in options
      ? (options.workspaceRepoPath ?? undefined)
      : remoteSession.repoPath;
  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    throw new ForkOperationError(
      "replay_unavailable",
      remoteSession.sourceSessionId,
      `Source session ${remoteSession.sourceSessionId} has no replay snapshot`
    );
  }

  let localKeys: KeyInfo[] | null = null;
  try {
    localKeys = await loadSharedLocalKeys();
  } catch {
    localKeys = null;
  }
  if (
    options.execution &&
    (localKeys === null ||
      !isModelRunnableWithAccount(
        options.execution.accountId,
        options.execution.model,
        localKeys
      ))
  ) {
    throw new Error(
      "The selected account/model is no longer available; choose another before forking."
    );
  }
  const store = getInstrumentedStore();
  const defaultModel =
    store.get(lastModelPairMapAtom)[DISPATCH_CATEGORY.RUST_AGENT]?.modelId;
  const resolvedModel = options.execution
    ? { model: options.execution.model, fellBack: false }
    : resolveForkModel(remoteSession.model, localKeys, defaultModel);

  // Full fetch from seq 0, same assembly + validation as the importer. Forks
  // additionally fail closed against the list-row summary: an internally
  // valid tail-only response must not materialize when the row promised a
  // larger frozen history.
  const assembled = await fetchAndAssembleSegments(options, 0, [], null);
  const summaryMatches =
    assembled !== null &&
    assembled.epoch === remoteSession.eventsEpoch &&
    assembled.frozenSeq === (remoteSession.eventsFrozenSeq ?? 0) &&
    assembled.events.length === remoteSession.eventsCount &&
    assembled.tailHash === (remoteSession.eventsTailHash ?? null);
  if (!summaryMatches) {
    throw new ForkSnapshotIntegrityError(
      FORK_SNAPSHOT_ERROR_KIND.SNAPSHOT_INCOMPLETE,
      `Fork snapshot does not match source summary for ${remoteSession.sourceSessionId}`
    );
  }

  const localSessionId = createForkedSessionId();
  const localEvents = rewriteEventsForImportedSnapshot(
    assembled.events,
    localSessionId
  );
  const now = new Date().toISOString();

  // Durable events first, session record second (mirror importRemoteSession):
  // if the cache write fails, no record must claim the fork exists.
  await eventStoreProxy.set(localEvents, localSessionId);
  const savedCount = await eventStoreProxy.saveToCache(localSessionId);
  if (localEvents.length > 0 && savedCount <= 0) {
    // Drop the just-set events again — no session record points at them, and
    // a fork id is random, so (unlike the importer's deterministic id) a
    // retry would not overwrite this orphan.
    await eventStoreProxy.clear(localSessionId);
    throw new Error(
      `Failed to durably persist forked session ${remoteSession.sourceSessionId} (saveToCache returned ${savedCount})`
    );
  }

  const forkedFrom: SessionForkedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    atCount: localEvents.length,
    forkedAt: now,
    // Root inheritance: forking a fork keeps pointing at the ORIGINAL
    // session, so the whole relay chain groups under one thread even when
    // intermediate parents age out of the retention window.
    rootSessionId:
      remoteSession.forkedFrom?.rootSessionId ?? remoteSession.sourceSessionId,
  };
  const name = buildForkedSessionName(remoteSession.title);
  upsertSession({
    session_id: localSessionId,
    status: "completed",
    created_at: now,
    updated_at: now,
    name,
    repoPath,
    branch: remoteSession.branch,
    // Runnable category (NOT "external_history"): the fork must be
    // dispatchable and eligible for collab push as this member's own session.
    category: DISPATCH_CATEGORY.RUST_AGENT,
    // Inherit the source's agent/model identity: the fork continues that
    // conversation, and teammate hover cards read these off the pushed
    // metadata. A later run with a different model overwrites them. The
    // model itself is only kept when it is runnable on the forker's OWN
    // keys (resolveForkModel) — otherwise the creator default, or unset.
    cliAgentType: remoteSession.cliAgentType as Session["cliAgentType"],
    agentDisplayName: remoteSession.agentDisplayName,
    model: resolvedModel.model,
    accountId: options.execution?.accountId,
    agentDefinitionId: options.execution?.agentDefinitionId,
    pinned: false,
    // Ownership stamp, same rule as importRemoteSession: a member's fork is
    // filed under the source org so the sidebar org selector lists it; a
    // guest (share-token) fork stays under Personal. Today forks only run in
    // member context (panel fork action), so the guard is future-proofing.
    orgId: shareToken ? undefined : orgId,
    forkedFrom,
    // Deliberately NO importedFrom: that field marks read-only replay copies
    // and excludes them from push (isSessionPushAllowed).
  });
  persistSessions(store.get(sessionsAtom) as Session[]);
  return {
    localSessionId,
    name,
    eventCount: localEvents.length,
    repoPath,
    model: resolvedModel.model,
    accountId: options.execution?.accountId,
    agentDefinitionId: options.execution?.agentDefinitionId,
    ...(resolvedModel.fellBack && remoteSession.model
      ? {
          modelFallback: {
            inheritedModel: remoteSession.model,
            fallbackModel: resolvedModel.model,
          },
        }
      : {}),
  };
}
