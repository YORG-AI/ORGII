import { collaborationSnapshotSecondaryProbe } from "@src/api/tauri/collaborationSnapshotIngest";
import { rpc, schemas } from "@src/api/tauri/rpc";
import {
  getExternalHistorySourceId,
  isCliSession,
  isCollaborationSnapshotSession,
} from "@src/util/session/sessionDispatch";

export const EXTERNAL_REPLAY_INVALIDATED_EVENT =
  "external-replay://invalidated" as const;

export type ExternalReplaySourceId =
  schemas.externalReplay.ExternalReplaySourceId;
export type ExternalReplayCursor = schemas.externalReplay.ExternalReplayCursor;
export type ExternalReplayWindow = schemas.externalReplay.ExternalReplayWindow;
export type ExternalReplayDelta = schemas.externalReplay.ExternalReplayDelta;
export type ExternalReplayHandoff =
  schemas.externalReplay.ExternalReplayHandoff;
export type ExternalReplayPayloadRange =
  schemas.externalReplay.ExternalReplayPayloadRange;
export type ExternalReplayExportFormat =
  schemas.externalReplay.ExternalReplayExportFormat;
export type ExternalReplayExportResult =
  schemas.externalReplay.ExternalReplayExportResult;
export type ExternalReplayOrgiiEnvelope =
  schemas.externalReplay.ExternalReplayOrgiiEnvelope;
export type ExternalReplayInvalidation =
  schemas.externalReplay.ExternalReplayInvalidation;
export type ExternalReplayLimits = Exclude<
  schemas.externalReplay.ExternalReplayLimits,
  undefined
>;
export type ExternalReplayCloudManifest =
  schemas.externalReplay.ExternalReplayCloudManifest;
export type ExternalReplayCloudBatch =
  schemas.externalReplay.ExternalReplayCloudBatch;

export interface ExternalReplayTarget {
  sourceId: ExternalReplaySourceId;
  sessionId: string;
}

const SNAPSHOT_BACKED_FORK_PREFIX = "agentsession-";

/**
 * Resolve the public session id to the source-aware replay transport.
 *
 * Managed CLI sessions deliberately stay keyed by their ORGII id. Rust owns
 * the native binding lookup (and the legacy chunks-mode SQL driver), so the
 * frontend never guesses a vendor-native id from stale status data.
 */
export function resolveExternalReplayTarget(
  sessionId: string
): ExternalReplayTarget | null {
  if (isCollaborationSnapshotSession(sessionId)) {
    return { sourceId: "collaboration_snapshot", sessionId };
  }
  if (isCliSession(sessionId)) {
    return { sourceId: "managed_cli", sessionId };
  }
  const sourceId = getExternalHistorySourceId(sessionId);
  return sourceId ? { sourceId, sessionId } : null;
}

/**
 * Resolve a replay target for read-only secondary consumers only.
 *
 * A normal native Agent remains absent from the primary replay registry. An
 * `agentsession-*` is admitted here only after Rust proves that an intact
 * collaboration snapshot index exists for its inherited prefix.
 */
export async function resolveSecondaryReplayTarget(
  sessionId: string
): Promise<ExternalReplayTarget | null> {
  const primary = resolveExternalReplayTarget(sessionId);
  if (primary) return primary;
  if (
    !sessionId.startsWith(SNAPSHOT_BACKED_FORK_PREFIX) ||
    sessionId.length <= SNAPSHOT_BACKED_FORK_PREFIX.length
  ) {
    return null;
  }
  return (await collaborationSnapshotSecondaryProbe(sessionId))
    ? { sourceId: "collaboration_snapshot", sessionId }
    : null;
}

function requireExternalReplayTarget(sessionId: string): ExternalReplayTarget {
  const target = resolveExternalReplayTarget(sessionId);
  if (!target) {
    throw new Error(`Session does not support bounded replay: ${sessionId}`);
  }
  return target;
}

export function externalReplayOpenWindow(
  sessionId: string,
  episodeId: number,
  limits?: ExternalReplayLimits
): Promise<ExternalReplayWindow> {
  return rpc.externalReplay.openWindow({
    ...requireExternalReplayTarget(sessionId),
    episodeId,
    limits,
  });
}

export function externalReplayPollDelta(
  sessionId: string,
  episodeId: number,
  cursor: ExternalReplayCursor,
  limits?: ExternalReplayLimits
): Promise<ExternalReplayDelta> {
  return rpc.externalReplay.pollDelta({
    ...requireExternalReplayTarget(sessionId),
    episodeId,
    cursor,
    limits,
  });
}

export function externalReplayReadWindow(options: {
  sessionId: string;
  episodeId: number;
  beforeSequence?: number;
  turnId?: string;
  turnIndex?: number;
  limits?: ExternalReplayLimits;
}): Promise<ExternalReplayWindow> {
  const { sessionId, episodeId, beforeSequence, turnId, turnIndex, limits } =
    options;
  return rpc.externalReplay.readWindow({
    ...requireExternalReplayTarget(sessionId),
    episodeId,
    beforeSequence,
    turnId,
    turnIndex,
    limits,
  });
}

/**
 * Pure bounded source query. Unlike foreground open/poll/read, this never
 * creates a watcher, mutates EventStore, emits `es:changed`, or invalidates a
 * visible replay episode.
 */
export function externalReplayQueryWindow(options: {
  sessionId: string;
  beforeSequence?: number;
  turnId?: string;
  turnIndex?: number;
  limits?: ExternalReplayLimits;
}): Promise<ExternalReplayWindow> {
  const { sessionId, beforeSequence, turnId, turnIndex, limits } = options;
  return externalReplayQueryWindowForTarget({
    target: requireExternalReplayTarget(sessionId),
    beforeSequence,
    turnId,
    turnIndex,
    limits,
  });
}

export function externalReplayQueryWindowForTarget(options: {
  target: ExternalReplayTarget;
  beforeSequence?: number;
  turnId?: string;
  turnIndex?: number;
  limits?: ExternalReplayLimits;
}): Promise<ExternalReplayWindow> {
  const { target, beforeSequence, turnId, turnIndex, limits } = options;
  return rpc.externalReplay.queryWindow({
    ...target,
    beforeSequence,
    turnId,
    turnIndex,
    limits,
  });
}

/**
 * Load and apply one latest bounded window entirely in Rust. The episode id
 * belongs to the independent prewarm lifecycle, not the foreground watcher.
 */
export function externalReplayPrewarmWindow(
  sessionId: string,
  episodeId: number,
  limits?: ExternalReplayLimits
): Promise<ExternalReplayWindow> {
  return rpc.externalReplay.prewarmWindow({
    ...requireExternalReplayTarget(sessionId),
    episodeId,
    limits,
  });
}

/**
 * Pure backend handoff fold for Fork. Rust pages the compact replay index and
 * returns at most 80 prompt-ready strings; no SessionEvent[] crosses IPC.
 */
export function externalReplayHandoff(options: {
  sessionId: string;
  sourceName: string;
}): Promise<ExternalReplayHandoff> {
  const { sessionId, sourceName } = options;
  return rpc.externalReplay.handoff({
    ...requireExternalReplayTarget(sessionId),
    sourceName,
  });
}

export function externalReplayRelease(
  sessionId: string,
  episodeId: number
): Promise<void> {
  return rpc.externalReplay.release({
    ...requireExternalReplayTarget(sessionId),
    episodeId,
  });
}

export function externalReplayReadPayloadRange(options: {
  sessionId: string;
  generation: string;
  eventId: string;
  fieldPath: string;
  offset: number;
  maxBytes?: number;
}): Promise<ExternalReplayPayloadRange> {
  const { sessionId, ...range } = options;
  return externalReplayReadPayloadRangeForTarget({
    target: requireExternalReplayTarget(sessionId),
    ...range,
  });
}

export function externalReplayReadPayloadRangeForTarget(options: {
  target: ExternalReplayTarget;
  generation: string;
  eventId: string;
  fieldPath: string;
  offset: number;
  maxBytes?: number;
}): Promise<ExternalReplayPayloadRange> {
  const { target, ...range } = options;
  return rpc.externalReplay.readPayloadRange({
    ...target,
    ...range,
  });
}

export function externalReplayStreamExport(options: {
  sessionId: string;
  destinationPath: string;
  format: ExternalReplayExportFormat;
  orgiiEnvelope?: ExternalReplayOrgiiEnvelope;
}): Promise<ExternalReplayExportResult> {
  const { sessionId, ...exportOptions } = options;
  return externalReplayStreamExportForTarget({
    target: requireExternalReplayTarget(sessionId),
    ...exportOptions,
  });
}

export function externalReplayStreamExportForTarget(options: {
  target: ExternalReplayTarget;
  destinationPath: string;
  format: ExternalReplayExportFormat;
  orgiiEnvelope?: ExternalReplayOrgiiEnvelope;
}): Promise<ExternalReplayExportResult> {
  const { target, ...exportOptions } = options;
  return rpc.externalReplay.streamExport({
    ...target,
    ...exportOptions,
  });
}

export function externalReplayCloudPrepare(
  sessionId: string
): Promise<ExternalReplayCloudManifest> {
  return externalReplayCloudPrepareForTarget(
    requireExternalReplayTarget(sessionId)
  );
}

export function externalReplayCloudPrepareForTarget(
  target: ExternalReplayTarget
): Promise<ExternalReplayCloudManifest> {
  return rpc.externalReplay.cloudPrepare(target);
}

export function externalReplayCloudReadBatch(options: {
  token: string;
  startEventIndex: number;
  endEventIndex: number;
  startSegmentIndex?: number;
  maxBytes?: number;
}): Promise<ExternalReplayCloudBatch> {
  return rpc.externalReplay.cloudReadBatch(options);
}

export function externalReplayCloudPrefixHash(options: {
  token: string;
  eventCount: number;
}): Promise<schemas.externalReplay.ExternalReplayCloudPrefixHash> {
  return rpc.externalReplay.cloudPrefixHash(options);
}

export function externalReplayCloudRelease(token: string): Promise<void> {
  return rpc.externalReplay.cloudRelease({ token });
}
