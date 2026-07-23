/**
 * Consolidated remote-session import (design §7.4, dedups the old M5 copies).
 *
 * `importRemoteSession` is THE consolidated teammate-session import (design
 * §7.4 + M5 dedup) — backend-agnostic, its only backend dependency being
 * bounded raw wire pages. Rust owns decode, validation and atomic publish;
 * the renderer never assembles a session-sized event array.
 */
import { indexOrgtrackCollaborationSession } from "@src/api/tauri/lineage";
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { recordGuestImportedSession } from "@src/store/session/sessionAtom/guestImportRegistry";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import type {
  Session,
  SessionImportedFrom,
} from "@src/store/session/sessionAtom/types";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  deriveImportedSessionId,
  findImportedSession,
  normalizeSourceEndpointUrl,
} from "./collabImportIdentity";
import {
  type RemoteSnapshotIngestOptions,
  ingestRemoteSnapshot,
} from "./collabSnapshotIngest";

const log = createLogger("collabSyncEngineHelpers");

export interface ImportRemoteSessionOptions extends Omit<
  RemoteSnapshotIngestOptions,
  "localSessionId" | "previous"
> {
  /** Deployment identity used to isolate deterministic local imports. */
  sourceEndpointUrl?: string;
  /** Non-secret endpoint associated with a guest replay capability. */
  shareEndpointUrl?: string;
  /**
   * Invoked with the local session id BEFORE any event-store write, so the
   * engine can arm its self-import guard (the eventStore write re-enters the
   * push subscription).
   */
  onBeforeWrite?: (localSessionId: string) => void;
  /**
   * Viewer-local checkout of the shared repo. When present, the authorized
   * replay is indexed into Session Blame with owner paths remapped to this
   * workspace. The owner's absolute `remoteSession.repoPath` is never used as
   * a local navigation path.
   */
  workspaceRepoPath?: string;
}

export interface ImportRemoteSessionResult {
  localSessionId: string;
  /**
   * false ⇒ replay events were unchanged. Display-only source metadata may
   * still have been refreshed on the existing local row.
   */
  updated: boolean;
}

/**
 * Per-source serialization. Each caller keeps its own AbortSignal and result;
 * concurrent attempts cannot interleave durable writes or cancel one another.
 */
const remoteSessionImportTails = new Map<string, Promise<void>>();

function resolveImportedSourceDisplay(
  remoteSession: ImportRemoteSessionOptions["remoteSession"],
  existing: Session | undefined
): NonNullable<SessionImportedFrom["sourceDisplay"]> {
  return {
    cliAgentType:
      remoteSession.cliAgentType ??
      existing?.importedFrom?.sourceDisplay?.cliAgentType,
    agentDisplayName:
      remoteSession.agentDisplayName ??
      existing?.importedFrom?.sourceDisplay?.agentDisplayName,
    agentDefinitionId:
      remoteSession.agentDefinitionId ??
      existing?.importedFrom?.sourceDisplay?.agentDefinitionId,
    model: remoteSession.model ?? existing?.importedFrom?.sourceDisplay?.model,
  };
}

function refreshImportedSessionPresentation(
  existing: Session,
  remoteSession: ImportRemoteSessionOptions["remoteSession"]
): void {
  const importedFrom = existing.importedFrom;
  if (!importedFrom) return;

  const externalHistorySource =
    remoteSession.origin?.kind === "external_history"
      ? remoteSession.origin.source
      : importedFrom.externalHistorySource;
  const sourceDisplay = resolveImportedSourceDisplay(remoteSession, existing);
  const ownerAvatarUrl =
    remoteSession.ownerAvatarUrl ?? importedFrom.ownerAvatarUrl;
  const repoPath = remoteSession.repoPath ?? existing.repoPath;
  const unchanged =
    existing.name === remoteSession.title &&
    existing.repoPath === repoPath &&
    importedFrom.ownerMemberId === remoteSession.ownerMemberId &&
    importedFrom.ownerDisplayName === remoteSession.ownerDisplayName &&
    importedFrom.ownerAvatarUrl === ownerAvatarUrl &&
    importedFrom.externalHistorySource === externalHistorySource &&
    importedFrom.sourceDisplay?.cliAgentType === sourceDisplay.cliAgentType &&
    importedFrom.sourceDisplay?.agentDisplayName ===
      sourceDisplay.agentDisplayName &&
    importedFrom.sourceDisplay?.agentDefinitionId ===
      sourceDisplay.agentDefinitionId &&
    importedFrom.sourceDisplay?.model === sourceDisplay.model;
  if (unchanged) return;

  const refreshed: Session = {
    ...existing,
    name: remoteSession.title,
    repoPath,
    importedFrom: {
      ...importedFrom,
      ownerMemberId: remoteSession.ownerMemberId,
      ownerDisplayName: remoteSession.ownerDisplayName,
      ownerAvatarUrl,
      externalHistorySource,
      sourceDisplay,
    },
  };
  upsertSession(refreshed);
  recordGuestImportedSession(refreshed);
  persistSessions(getInstrumentedStore().get(sessionsAtom) as Session[]);
}

/**
 * THE import path for teammate sessions — used by both the engine PullLoop
 * (auto-import) and the panel's direct-replay action. Handles:
 * - cursor comparison against the remote summary (no-op when unchanged),
 * - incremental application (new frozen segments appended to the local
 *   frozen prefix, tail region replaced) with local-count + contiguity
 *   validation, falling back to a full refetch on any mismatch,
 * - persistence (`saveToCache`, fix P7) and the `importedFrom` cursor.
 *
 * Concurrent calls for the same source serialize without sharing a caller's
 * cancellation. Returns null when the owner has published no segments and nothing
 * was previously imported (callers may fall back to the snapshot-request
 * flow); THROWS when the durable cache write fails so callers treat the
 * import as retryable rather than silently absent.
 */
export async function importRemoteSession(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const endpoint = normalizeSourceEndpointUrl(
    options.sourceEndpointUrl ??
      options.shareEndpointUrl ??
      "unknown-cloud-endpoint"
  );
  const key = `${endpoint}:${options.orgId}:${options.remoteSession.sourceSessionId}`;
  const previous = remoteSessionImportTails.get(key) ?? Promise.resolve();
  const task = previous
    .catch(() => undefined)
    .then(() =>
      importRemoteSessionInner({ ...options, sourceEndpointUrl: endpoint })
    );
  const tail = task.then(
    () => undefined,
    () => undefined
  );
  remoteSessionImportTails.set(key, tail);
  let result: ImportRemoteSessionResult | null;
  try {
    result = await task;
  } finally {
    if (remoteSessionImportTails.get(key) === tail) {
      remoteSessionImportTails.delete(key);
    }
  }
  if (result && options.workspaceRepoPath) {
    try {
      await indexOrgtrackCollaborationSession({
        localSessionId: result.localSessionId,
        sourceSessionId: options.remoteSession.sourceSessionId,
        title: options.remoteSession.title,
        workspacePath: options.workspaceRepoPath,
        sourceWorkspacePath: options.remoteSession.repoPath,
        orgId: options.orgId,
        sessionRowId: options.remoteSession.id,
        ownerMemberId: options.remoteSession.ownerMemberId,
        ownerDisplayName: options.remoteSession.ownerDisplayName,
      });
    } catch (error) {
      // Replay remains usable; every later open retries this derived index.
      log.warn("failed to index collaboration replay for Session Blame", {
        localSessionId: result.localSessionId,
        error,
      });
    }
  }
  return result;
}

async function importRemoteSessionInner(
  options: ImportRemoteSessionOptions
): Promise<ImportRemoteSessionResult | null> {
  const {
    orgId,
    remoteSession,
    onBeforeWrite,
    shareToken,
    shareEndpointUrl,
    sourceEndpointUrl = "unknown-cloud-endpoint",
  } = options;
  const store = getInstrumentedStore();
  const sessions = store.get(sessionsAtom) as Session[];
  const existing = findImportedSession(
    sessions,
    orgId,
    remoteSession.sourceSessionId,
    sourceEndpointUrl
  );
  // Legacy (error_message) imports have no usable cursor and are rebuilt by
  // the bounded Rust ingester. No renderer-side full-history fallback exists.
  const cursor = existing?.importedFrom ?? null;

  if (
    remoteSession.eventsEpoch === undefined ||
    remoteSession.eventsCount === undefined
  ) {
    // No segments published (or publishing stopped): keep any local copy.
    if (!existing) return null;
    refreshImportedSessionPresentation(existing, remoteSession);
    return { localSessionId: existing.session_id, updated: false };
  }

  // Deterministic id (not random): a retry after a failed durable write must
  // reuse the same local id instead of leaking a new orphan per attempt.
  const localSessionId =
    existing?.session_id ??
    (await deriveImportedSessionId(
      orgId,
      remoteSession.sourceSessionId,
      sourceEndpointUrl
    ));
  const previous =
    cursor && cursor.frozenCount !== undefined
      ? {
          epoch: cursor.epoch,
          frozenSeq: cursor.seq,
          count: cursor.count,
          frozenCount: cursor.frozenCount,
          tailHash: cursor.tailHash ?? null,
        }
      : undefined;

  // Arm the push-loop self-import guard before Rust atomically publishes any
  // rows. Wire pages remain opaque gzip strings in JS throughout this call.
  onBeforeWrite?.(localSessionId);
  const committed = await ingestRemoteSnapshot({
    client: options.client,
    orgId,
    remoteSession,
    localSessionId,
    ...(previous !== undefined ? { previous } : {}),
    ...(shareToken !== undefined ? { shareToken } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!committed) {
    return existing
      ? { localSessionId: existing.session_id, updated: false }
      : null;
  }

  const now = new Date().toISOString();
  const importedFrom: SessionImportedFrom = {
    orgId,
    sourceSessionId: remoteSession.sourceSessionId,
    sourceEndpointUrl,
    ownerMemberId: remoteSession.ownerMemberId,
    ownerDisplayName: remoteSession.ownerDisplayName,
    ownerAvatarUrl: remoteSession.ownerAvatarUrl,
    externalHistorySource:
      remoteSession.origin?.kind === "external_history"
        ? remoteSession.origin.source
        : existing?.importedFrom?.externalHistorySource,
    sourceDisplay: resolveImportedSourceDisplay(remoteSession, existing),
    epoch: committed.epoch,
    seq: committed.frozenSeq,
    count: committed.eventCount,
    frozenCount: committed.frozenEventCount,
    tailHash: committed.tailHash ?? undefined,
    importedAt: now,
    shareToken: shareToken ?? existing?.importedFrom?.shareToken,
    shareEndpointUrl:
      shareEndpointUrl ?? existing?.importedFrom?.shareEndpointUrl,
  };
  const importedRow: Session = {
    session_id: localSessionId,
    status: "completed",
    created_at: existing?.created_at ?? now,
    updated_at: now,
    completed_at: now,
    name: remoteSession.title,
    repoPath: remoteSession.repoPath,
    category: "external_history",
    // No runnable model: the imported copy's composer is a FORK ENTRY, not a
    // live agent. The source model is retained under importedFrom.sourceDisplay
    // for read-only presentation, while leaving this field unset makes the
    // composer ask which of the viewer's OWN local models/keys the fork should
    // actually use.
    model: undefined,
    agentIconId: "archive",
    agentDisplayName: "Collaboration Snapshot",
    pinned: existing?.pinned ?? false,
    // Ownership stamp (`Session.orgId`, distinct from `importedFrom.orgId`
    // provenance — see sessionAtom/types.ts): filing the import under the
    // org makes it match the sidebar org selector. Only MEMBER imports are
    // stamped — the engine PullLoop and the panel replay both run in member
    // context (org sync profile, no token). A share-token import is the
    // GUEST path (CollabShareImportDialog, no local membership): it stays
    // under Personal, i.e. no orgId (preserving any prior member stamp).
    orgId: shareToken ? existing?.orgId : orgId,
    importedFrom,
    // Retire the legacy error_message idiom for collab imports; clears any
    // leftover value on upgraded pre-M3 rows.
    error_message: undefined,
  };
  // No await after the Rust transaction: the session row, guest registry and
  // persisted list commit synchronously as one local critical section.
  upsertSession(importedRow);
  recordGuestImportedSession(importedRow);
  persistSessions(store.get(sessionsAtom) as Session[]);

  const updated =
    !cursor ||
    cursor.epoch !== committed.epoch ||
    cursor.seq !== committed.frozenSeq ||
    cursor.count !== committed.eventCount ||
    cursor.frozenCount !== committed.frozenEventCount ||
    (cursor.tailHash ?? null) !== committed.tailHash;
  return { localSessionId, updated };
}
