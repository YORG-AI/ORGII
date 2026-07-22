/**
 * Fork & continue (design §16.11 — session relay).
 *
 * `forkSession` is the WRITABLE sibling of `importRemoteSession`
 * (`collabSessionImport.ts`): backend-agnostic, sharing the bounded wire-page
 * ingest path, and differing only in the kind of local session the committed
 * snapshot lands in.
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
import {
  type RemoteSnapshotIngestOptions,
  ingestRemoteSnapshot,
} from "./collabSnapshotIngest";

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
  /** Rust-folded handoff context; never derived from a full renderer array. */
  handoffItems: string[];
}

export interface ForkExecutionSelection {
  agentDefinitionId: string;
  accountId: string;
  model: string;
}

export interface ForkSessionOptions extends Omit<
  RemoteSnapshotIngestOptions,
  "localSessionId" | "previous"
> {
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
 * authoritative event history as a new WRITABLE local session, so an agent
 * can run on this machine, with this member's key, continuing from the
 * teammate's context. The history is streamed as bounded opaque wire pages
 * into Rust; the renderer never assembles a session-sized event array. NOT
 * multi-writer — the fork is an ordinary single-writer session that merely
 * records its origin in `forkedFrom`.
 *
 * Shares the exact staged-ingest path with `importRemoteSession`. A fork has
 * no incremental cursor, so Rust rebuilds its local snapshot from bounded
 * backward pages and atomically publishes it before the session record is
 * persisted. A failed ingest therefore cannot leave a runnable fork record
 * with partial history.
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

  const localSessionId = createForkedSessionId();
  const committed = await ingestRemoteSnapshot({
    client: options.client,
    orgId,
    remoteSession,
    localSessionId,
    ...(shareToken !== undefined ? { shareToken } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  // Forks fail closed against the list-row summary. Unlike the old path, the
  // comparison is against Rust's atomically committed counters rather than a
  // renderer-sized `assembled.events` array.
  if (
    committed === null ||
    committed.epoch !== remoteSession.eventsEpoch ||
    committed.frozenSeq !== (remoteSession.eventsFrozenSeq ?? 0) ||
    committed.eventCount !== remoteSession.eventsCount ||
    committed.tailHash !== (remoteSession.eventsTailHash ?? null)
  ) {
    await eventStoreProxy
      .clearPersistedHistory(localSessionId)
      .catch(() => undefined);
    throw new ForkSnapshotIntegrityError(
      FORK_SNAPSHOT_ERROR_KIND.SNAPSHOT_INCOMPLETE,
      `Fork snapshot does not match source summary for ${remoteSession.sourceSessionId}`
    );
  }

  const now = new Date().toISOString();

  const forkedFrom: SessionForkedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    atCount: committed.eventCount,
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
    eventCount: committed.eventCount,
    repoPath,
    model: resolvedModel.model,
    accountId: options.execution?.accountId,
    agentDefinitionId: options.execution?.agentDefinitionId,
    handoffItems: committed.handoffItems,
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
