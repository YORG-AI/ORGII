/**
 * The single local persistence boundary for shared-conversation execution.
 *
 * Each (executor scope, root session) has its own localStorage entry. Keeping
 * entries split prevents an unrelated conversation write in another desktop
 * window from replacing the whole registry blob. The legacy one-shot runner
 * blob remains readable so an upgrade never exposes plumbing sessions in My
 * Sessions.
 */
import { conversationExecutionKey } from "@src/engines/SessionCore/conversations";

export { conversationExecutionKey };

const STORE_VERSION = 2 as const;
const STORAGE_KEY_PREFIX = "orgii:conversation-execution-v2:";
const LEGACY_EXECUTION_STORE_VERSION = 1 as const;
const LEGACY_EXECUTION_STORAGE_KEY_PREFIX = "orgii:conversation-execution-v1:";
const LEGACY_RUNNERS_KEY = "orgii:conversation-runners-v1";
const UNKNOWN_UPDATED_AT = "1970-01-01T00:00:00.000Z";
export const MAX_CONVERSATION_CONTINUATION_EPISODES = 16;

export interface ConversationRunnerRegistryEntry {
  runnerSessionIds: string[];
  terminalRunnerSessionIds: string[];
  updatedAt: string;
}

export interface ConversationContinuationRecord {
  /** Stable lineage node. Derived from the runner id for legacy records. */
  episodeId: string;
  continuationSessionId: string;
  /** Highest plane seq this continuation has successfully consumed. */
  readThroughPlaneSeq: number;
  /** False only between preparing a blank runner and adapter acceptance. */
  established: boolean;
  bootstrapTurnIntentId?: string;
  agentDefinitionId: string;
  /** Managed External CLI platform; absent means the native Agent runtime. */
  cliAgentType?: string;
  accountId?: string;
  model?: string;
  workspaceRepoPath?: string | null;
  updatedAt: string;
}

export type ConversationContinuationEpisodeState =
  | "prepared"
  | "active"
  | "retired"
  | "failed";

/**
 * Immutable execution identity plus the mutable lifecycle/cursor of one
 * native runner. Retired nodes remain as bounded metadata so a runtime roll
 * is explainable without keeping old transcripts in localStorage.
 */
export interface ConversationContinuationEpisode extends ConversationContinuationRecord {
  state: ConversationContinuationEpisodeState;
  createdAt: string;
  supersedesEpisodeId?: string;
  rollReason?: string;
}

export interface ConversationContinuationLineage {
  activeEpisodeId?: string;
  episodes: ConversationContinuationEpisode[];
  updatedAt: string;
}

export type ConversationContinuationInput = Omit<
  ConversationContinuationRecord,
  "episodeId" | "updatedAt"
> & { episodeId?: string };

export interface ConversationPlaneReadCursor {
  readThroughPlaneSeq: number;
  updatedAt: string;
}

interface ConversationExecutionEnvelope {
  version: typeof STORE_VERSION;
  runners?: ConversationRunnerRegistryEntry;
  /** Authoritative continuation state. */
  continuationLineage?: ConversationContinuationLineage;
  /** Independent cursor for execution directly in the owner's root session. */
  ownerPlaneCursor?: ConversationPlaneReadCursor;
}

interface LegacyConversationExecutionEnvelope {
  version: typeof LEGACY_EXECUTION_STORE_VERSION;
  runners?: ConversationRunnerRegistryEntry;
  continuation?: ConversationContinuationRecord;
  ownerPlaneCursor?: ConversationPlaneReadCursor;
}

function defaultStorage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJson(backing: Storage | null, key: string): unknown {
  if (!backing) return null;
  try {
    const raw = backing.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (candidate): candidate is string =>
          typeof candidate === "string" && candidate.length > 0
      )
    ),
  ];
}

function validPlaneSeq(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalString(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  return typeof source[key] === "string" && source[key].length > 0
    ? source[key]
    : undefined;
}

function sanitizeRunners(
  value: unknown
): ConversationRunnerRegistryEntry | null {
  if (!isObject(value)) return null;
  const runnerSessionIds = uniqueStrings(value.runnerSessionIds);
  if (runnerSessionIds.length === 0) return null;
  const registered = new Set(runnerSessionIds);
  return {
    runnerSessionIds,
    terminalRunnerSessionIds: uniqueStrings(
      value.terminalRunnerSessionIds
    ).filter((sessionId) => registered.has(sessionId)),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt
        : UNKNOWN_UPDATED_AT,
  };
}

function sanitizeContinuation(
  value: unknown
): ConversationContinuationRecord | null {
  if (!isObject(value)) return null;
  const continuationSessionId = optionalString(value, "continuationSessionId");
  const agentDefinitionId = optionalString(value, "agentDefinitionId");
  if (
    !continuationSessionId ||
    !agentDefinitionId ||
    !validPlaneSeq(value.readThroughPlaneSeq) ||
    typeof value.established !== "boolean"
  ) {
    return null;
  }
  const bootstrapTurnIntentId = optionalString(value, "bootstrapTurnIntentId");
  if (
    (!value.established && !bootstrapTurnIntentId) ||
    (value.established && bootstrapTurnIntentId)
  ) {
    return null;
  }
  const record: ConversationContinuationRecord = {
    episodeId:
      optionalString(value, "episodeId") ??
      episodeIdForRunner(continuationSessionId),
    continuationSessionId,
    readThroughPlaneSeq: value.readThroughPlaneSeq,
    established: value.established,
    agentDefinitionId,
    updatedAt: optionalString(value, "updatedAt") ?? UNKNOWN_UPDATED_AT,
  };
  if (bootstrapTurnIntentId) {
    record.bootstrapTurnIntentId = bootstrapTurnIntentId;
  }
  const accountId = optionalString(value, "accountId");
  if (accountId) record.accountId = accountId;
  const model = optionalString(value, "model");
  if (model) record.model = model;
  const cliAgentType = optionalString(value, "cliAgentType");
  if (cliAgentType) record.cliAgentType = cliAgentType;
  if (
    typeof value.workspaceRepoPath === "string" ||
    value.workspaceRepoPath === null
  ) {
    record.workspaceRepoPath = value.workspaceRepoPath;
  }
  return record;
}

function episodeIdForRunner(continuationSessionId: string): string {
  return `conversation-episode:${continuationSessionId}`;
}

function isEpisodeState(
  value: unknown
): value is ConversationContinuationEpisodeState {
  return (
    value === "prepared" ||
    value === "active" ||
    value === "retired" ||
    value === "failed"
  );
}

function sanitizeEpisode(
  value: unknown
): ConversationContinuationEpisode | null {
  if (!isObject(value)) return null;
  const record = sanitizeContinuation(value);
  if (!record || !isEpisodeState(value.state)) return null;
  if (
    (value.state === "prepared" && record.established) ||
    (value.state === "active" && !record.established)
  ) {
    return null;
  }
  const episode: ConversationContinuationEpisode = {
    ...record,
    state: value.state,
    createdAt: optionalString(value, "createdAt") ?? record.updatedAt,
  };
  const supersedesEpisodeId = optionalString(value, "supersedesEpisodeId");
  if (supersedesEpisodeId) episode.supersedesEpisodeId = supersedesEpisodeId;
  const rollReason = optionalString(value, "rollReason");
  if (rollReason) episode.rollReason = rollReason;
  return episode;
}

function activeEpisode(
  lineage: ConversationContinuationLineage | null | undefined
): ConversationContinuationEpisode | null {
  if (!lineage?.activeEpisodeId) return null;
  const episode = lineage.episodes.find(
    (candidate) => candidate.episodeId === lineage.activeEpisodeId
  );
  return episode && (episode.state === "prepared" || episode.state === "active")
    ? episode
    : null;
}

function sanitizeLineage(
  value: unknown,
  legacyContinuation: ConversationContinuationRecord | null
): ConversationContinuationLineage | null {
  if (isObject(value) && Array.isArray(value.episodes)) {
    const seen = new Set<string>();
    const sanitizedEpisodes = value.episodes
      .map(sanitizeEpisode)
      .filter((episode): episode is ConversationContinuationEpisode => {
        if (!episode || seen.has(episode.episodeId)) return false;
        seen.add(episode.episodeId);
        return true;
      });
    const requestedActiveEpisodeId = optionalString(value, "activeEpisodeId");
    const requestedActiveEpisode = sanitizedEpisodes.find(
      (episode) =>
        episode.episodeId === requestedActiveEpisodeId &&
        (episode.state === "prepared" || episode.state === "active")
    );
    const recentEpisodes = sanitizedEpisodes.slice(
      -MAX_CONVERSATION_CONTINUATION_EPISODES
    );
    const episodes =
      requestedActiveEpisode && !recentEpisodes.includes(requestedActiveEpisode)
        ? [
            requestedActiveEpisode,
            ...sanitizedEpisodes
              .filter((episode) => episode !== requestedActiveEpisode)
              .slice(-(MAX_CONVERSATION_CONTINUATION_EPISODES - 1)),
          ]
        : recentEpisodes;
    const activeEpisodeId = requestedActiveEpisode?.episodeId;
    if (episodes.length > 0) {
      return {
        ...(activeEpisodeId ? { activeEpisodeId } : {}),
        episodes,
        updatedAt: optionalString(value, "updatedAt") ?? UNKNOWN_UPDATED_AT,
      };
    }
  }
  if (!legacyContinuation) return null;
  const legacyEpisode: ConversationContinuationEpisode = {
    ...legacyContinuation,
    state: legacyContinuation.established ? "active" : "prepared",
    createdAt: legacyContinuation.updatedAt,
  };
  return {
    activeEpisodeId: legacyEpisode.episodeId,
    episodes: [legacyEpisode],
    updatedAt: legacyEpisode.updatedAt,
  };
}

function sanitizePlaneCursor(
  value: unknown
): ConversationPlaneReadCursor | null {
  if (!isObject(value) || !validPlaneSeq(value.readThroughPlaneSeq)) {
    return null;
  }
  return {
    readThroughPlaneSeq: value.readThroughPlaneSeq,
    updatedAt: optionalString(value, "updatedAt") ?? UNKNOWN_UPDATED_AT,
  };
}

function normalizeExecutionKey(key: string): string | null {
  try {
    const parsed = JSON.parse(key) as unknown;
    return Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === "string" && part.length > 0)
      ? JSON.stringify(parsed)
      : null;
  } catch {
    return null;
  }
}

function entryStorageKey(executionKey: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(executionKey)}`;
}

function legacyEntryStorageKey(executionKey: string): string {
  return `${LEGACY_EXECUTION_STORAGE_KEY_PREFIX}${encodeURIComponent(
    executionKey
  )}`;
}

function executionKeyFromStorageKey(
  storageKey: string,
  prefix = STORAGE_KEY_PREFIX
): string | null {
  if (!storageKey.startsWith(prefix)) return null;
  try {
    return normalizeExecutionKey(
      decodeURIComponent(storageKey.slice(prefix.length))
    );
  } catch {
    return null;
  }
}

function readCurrentEnvelope(
  backing: Storage | null,
  executionKey: string
): ConversationExecutionEnvelope | null {
  const parsed = readJson(backing, entryStorageKey(executionKey));
  if (!isObject(parsed) || parsed.version !== STORE_VERSION) return null;
  const runners = sanitizeRunners(parsed.runners);
  const continuationLineage = sanitizeLineage(parsed.continuationLineage, null);
  const ownerPlaneCursor = sanitizePlaneCursor(parsed.ownerPlaneCursor);
  return {
    version: STORE_VERSION,
    ...(runners ? { runners } : {}),
    ...(continuationLineage ? { continuationLineage } : {}),
    ...(ownerPlaneCursor ? { ownerPlaneCursor } : {}),
  };
}

function readLegacyExecutionEnvelope(
  backing: Storage | null,
  executionKey: string
): ConversationExecutionEnvelope | null {
  const parsed = readJson(backing, legacyEntryStorageKey(executionKey));
  if (!isObject(parsed) || parsed.version !== LEGACY_EXECUTION_STORE_VERSION) {
    return null;
  }
  const legacy = parsed as unknown as LegacyConversationExecutionEnvelope;
  const runners = sanitizeRunners(legacy.runners);
  const continuation = sanitizeContinuation(legacy.continuation);
  const continuationLineage = sanitizeLineage(null, continuation);
  const ownerPlaneCursor = sanitizePlaneCursor(legacy.ownerPlaneCursor);
  return {
    version: STORE_VERSION,
    ...(runners ? { runners } : {}),
    ...(continuationLineage ? { continuationLineage } : {}),
    ...(ownerPlaneCursor ? { ownerPlaneCursor } : {}),
  };
}

/**
 * A valid v2 envelope owns the execution key, including an empty tombstone.
 * The immutable v1 entry is consulted only until the first v2 mutation.
 */
function readEnvelope(
  backing: Storage | null,
  executionKey: string
): ConversationExecutionEnvelope | null {
  return (
    readCurrentEnvelope(backing, executionKey) ??
    readLegacyExecutionEnvelope(backing, executionKey)
  );
}

function writeEnvelope(
  backing: Storage | null,
  executionKey: string,
  envelope: ConversationExecutionEnvelope
): void {
  if (!backing) {
    throw new Error("conversation execution storage unavailable");
  }
  // Persist an empty v2 tombstone as well. Removing it could expose a stale v1
  // record written by an older window after this build retired the runner.
  const storageKey = entryStorageKey(executionKey);
  const serialized = JSON.stringify(envelope);
  backing.setItem(storageKey, serialized);
  if (backing.getItem(storageKey) !== serialized) {
    throw new Error("conversation execution state did not persist");
  }
}

function mutateEnvelope(
  backing: Storage | null,
  key: string,
  mutate: (envelope: ConversationExecutionEnvelope) => boolean
): void {
  const normalized = normalizeExecutionKey(key);
  if (!normalized)
    throw new Error(`invalid conversation execution key: ${key}`);
  const envelope = readEnvelope(backing, normalized) ?? {
    version: STORE_VERSION,
  };
  if (!mutate(envelope)) return;
  writeEnvelope(backing, normalized, envelope);
}

function allStorageKeys(backing: Storage | null): string[] {
  if (!backing) return [];
  const keys: string[] = [];
  for (let index = 0; index < backing.length; index += 1) {
    const key = backing.key(index);
    if (key) keys.push(key);
  }
  return keys;
}

function readLegacyRunnerMap(backing: Storage | null): Record<string, unknown> {
  const parsed = readJson(backing, LEGACY_RUNNERS_KEY);
  return isObject(parsed) ? parsed : {};
}

function keyFor(executorScope: string, rootSessionId: string): string {
  return conversationExecutionKey(executorScope, rootSessionId);
}

function ensureLineage(
  envelope: ConversationExecutionEnvelope,
  updatedAt: string
): ConversationContinuationLineage {
  const lineage = envelope.continuationLineage ?? {
    episodes: [],
    updatedAt,
  };
  envelope.continuationLineage = lineage;
  return lineage;
}

function continuationEpisodeFromRecord(
  record: ConversationContinuationInput,
  updatedAt: string,
  previousActiveEpisodeId?: string
): ConversationContinuationEpisode {
  const episodeId =
    record.episodeId || episodeIdForRunner(record.continuationSessionId);
  return {
    ...record,
    episodeId,
    state: record.established ? "active" : "prepared",
    createdAt: updatedAt,
    updatedAt,
    ...(previousActiveEpisodeId && previousActiveEpisodeId !== episodeId
      ? { supersedesEpisodeId: previousActiveEpisodeId }
      : {}),
  };
}

function installActiveEpisode(
  envelope: ConversationExecutionEnvelope,
  record: ConversationContinuationInput,
  updatedAt: string
): void {
  const lineage = ensureLineage(envelope, updatedAt);
  const previousActive = activeEpisode(lineage);
  const nextEpisodeId =
    record.episodeId || episodeIdForRunner(record.continuationSessionId);
  if (previousActive && previousActive.episodeId !== nextEpisodeId) {
    previousActive.state = "retired";
    previousActive.rollReason ??= "superseded";
    previousActive.updatedAt = updatedAt;
  }
  const episode = continuationEpisodeFromRecord(
    record,
    updatedAt,
    previousActive?.episodeId
  );
  const existingIndex = lineage.episodes.findIndex(
    (candidate) => candidate.episodeId === episode.episodeId
  );
  if (existingIndex >= 0) {
    episode.createdAt = lineage.episodes[existingIndex].createdAt;
    lineage.episodes[existingIndex] = episode;
  } else {
    lineage.episodes.push(episode);
  }
  lineage.activeEpisodeId = episode.episodeId;
  lineage.updatedAt = updatedAt;
  lineage.episodes = lineage.episodes.slice(
    -MAX_CONVERSATION_CONTINUATION_EPISODES
  );
}

function mutateActiveEpisode(
  envelope: ConversationExecutionEnvelope,
  mutate: (episode: ConversationContinuationEpisode) => boolean
): boolean {
  const episode = activeEpisode(envelope.continuationLineage);
  if (!episode || !mutate(episode)) return false;
  const now = new Date().toISOString();
  episode.updatedAt = now;
  if (envelope.continuationLineage) {
    envelope.continuationLineage.updatedAt = now;
  }
  return true;
}

export function loadStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): ConversationContinuationRecord | null {
  const key = keyFor(executorScope, rootSessionId);
  return activeEpisode(readEnvelope(backing, key)?.continuationLineage);
}

export function loadStoredContinuationLineage(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): ConversationContinuationLineage | null {
  const key = keyFor(executorScope, rootSessionId);
  return readEnvelope(backing, key)?.continuationLineage ?? null;
}

function assertValidContinuationRecord(
  record: ConversationContinuationInput
): void {
  if (
    !validPlaneSeq(record.readThroughPlaneSeq) ||
    !record.continuationSessionId ||
    !record.agentDefinitionId ||
    (!record.established && !record.bootstrapTurnIntentId) ||
    (record.established && record.bootstrapTurnIntentId)
  ) {
    throw new Error("invalid conversation continuation record");
  }
}

export function saveStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  record: ConversationContinuationInput,
  backing: Storage | null = defaultStorage()
): void {
  assertValidContinuationRecord(record);
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    installActiveEpisode(envelope, record, new Date().toISOString());
    return true;
  });
}

/** Atomically hide a newly created runner and install its continuation. */
export function prepareStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  record: ConversationContinuationInput,
  preparedAt: string,
  backing: Storage | null = defaultStorage()
): void {
  assertValidContinuationRecord(record);
  const key = keyFor(executorScope, rootSessionId);
  mutateEnvelope(backing, key, (envelope) => {
    const current = envelope.runners;
    envelope.runners = {
      runnerSessionIds: [
        ...new Set([
          ...(current?.runnerSessionIds ?? []),
          record.continuationSessionId,
        ]),
      ],
      terminalRunnerSessionIds: current?.terminalRunnerSessionIds ?? [],
      updatedAt: preparedAt,
    };
    installActiveEpisode(envelope, record, preparedAt);
    return true;
  });
}

export function clearStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): void {
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    const lineage = envelope.continuationLineage;
    const episode = activeEpisode(lineage);
    if (!lineage || !episode) return false;
    const now = new Date().toISOString();
    episode.state = "retired";
    episode.rollReason ??= "cleared";
    episode.updatedAt = now;
    delete lineage.activeEpisodeId;
    lineage.updatedAt = now;
    return true;
  });
}

export function retireStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  rollReason: string,
  state: Extract<
    ConversationContinuationEpisodeState,
    "retired" | "failed"
  > = "retired",
  backing: Storage | null = defaultStorage()
): ConversationContinuationEpisode | null {
  let retired: ConversationContinuationEpisode | null = null;
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    const lineage = envelope.continuationLineage;
    const episode = activeEpisode(lineage);
    if (!lineage || !episode || !rollReason.trim()) return false;
    const now = new Date().toISOString();
    episode.state = state;
    episode.rollReason = rollReason;
    episode.updatedAt = now;
    delete lineage.activeEpisodeId;
    lineage.updatedAt = now;
    retired = { ...episode };
    return true;
  });
  return retired;
}

/** Fence bootstrap completion to the exact local runner and logical intent. */
export function markStoredContinuationEstablished(
  executorScope: string,
  rootSessionId: string,
  continuationSessionId: string,
  bootstrapTurnIntentId: string,
  backing: Storage | null = defaultStorage()
): boolean {
  let established = false;
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    const continuation = activeEpisode(envelope.continuationLineage);
    if (
      !continuation ||
      continuation.continuationSessionId !== continuationSessionId ||
      continuation.established ||
      continuation.bootstrapTurnIntentId !== bootstrapTurnIntentId
    ) {
      return false;
    }
    continuation.established = true;
    continuation.state = "active";
    delete continuation.bootstrapTurnIntentId;
    established = true;
    return mutateActiveEpisode(envelope, () => true);
  });
  return established;
}

export function advanceStoredContinuationReadThrough(
  executorScope: string,
  rootSessionId: string,
  planeSeq: number,
  backing: Storage | null = defaultStorage()
): void {
  if (!validPlaneSeq(planeSeq)) {
    throw new Error(`invalid conversation plane seq: ${planeSeq}`);
  }
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    return mutateActiveEpisode(envelope, (continuation) => {
      if (continuation.readThroughPlaneSeq >= planeSeq) return false;
      continuation.readThroughPlaneSeq = planeSeq;
      return true;
    });
  });
}

export function loadStoredOwnerPlaneCursor(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): ConversationPlaneReadCursor | null {
  const key = keyFor(executorScope, rootSessionId);
  return readEnvelope(backing, key)?.ownerPlaneCursor ?? null;
}

export function advanceStoredOwnerPlaneCursor(
  executorScope: string,
  rootSessionId: string,
  planeSeq: number,
  backing: Storage | null = defaultStorage()
): void {
  if (!validPlaneSeq(planeSeq)) {
    throw new Error(`invalid conversation plane seq: ${planeSeq}`);
  }
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    const current = envelope.ownerPlaneCursor?.readThroughPlaneSeq ?? 0;
    if (current >= planeSeq) return false;
    envelope.ownerPlaneCursor = {
      readThroughPlaneSeq: planeSeq,
      updatedAt: new Date().toISOString(),
    };
    return true;
  });
}

export function loadStoredRunnerRegistryEntry(
  key: string,
  backing: Storage | null = defaultStorage()
): ConversationRunnerRegistryEntry | null {
  const normalized = normalizeExecutionKey(key);
  return normalized
    ? (readEnvelope(backing, normalized)?.runners ?? null)
    : null;
}

export function registerStoredRunner(
  key: string,
  runnerSessionId: string,
  updatedAt: string,
  backing: Storage | null = defaultStorage()
): void {
  mutateEnvelope(backing, key, (envelope) => {
    const current = envelope.runners;
    envelope.runners = {
      runnerSessionIds: [
        ...new Set([...(current?.runnerSessionIds ?? []), runnerSessionId]),
      ],
      terminalRunnerSessionIds: current?.terminalRunnerSessionIds ?? [],
      updatedAt,
    };
    return true;
  });
}

export function markStoredRunnerTerminal(
  key: string,
  runnerSessionId: string,
  backing: Storage | null = defaultStorage()
): void {
  const normalized = normalizeExecutionKey(key);
  if (!normalized) return;
  mutateEnvelope(backing, normalized, (envelope) => {
    const current = envelope.runners;
    if (!current?.runnerSessionIds.includes(runnerSessionId)) return false;
    envelope.runners = {
      ...current,
      terminalRunnerSessionIds: [
        ...new Set([...current.terminalRunnerSessionIds, runnerSessionId]),
      ],
      updatedAt: new Date().toISOString(),
    };
    return true;
  });
}

/** Every current and legacy runner id on this device. */
export function collectStoredRunnerSessionIds(
  backing: Storage | null = defaultStorage()
): Set<string> {
  const sessionIds = new Set<string>();
  const currentExecutionKeys = new Set<string>();
  for (const storageKey of allStorageKeys(backing)) {
    const executionKey = executionKeyFromStorageKey(storageKey);
    if (!executionKey) continue;
    const current = readCurrentEnvelope(backing, executionKey);
    if (!current) continue;
    currentExecutionKeys.add(executionKey);
    for (const sessionId of current.runners?.runnerSessionIds ?? []) {
      sessionIds.add(sessionId);
    }
  }
  for (const storageKey of allStorageKeys(backing)) {
    const executionKey = executionKeyFromStorageKey(
      storageKey,
      LEGACY_EXECUTION_STORAGE_KEY_PREFIX
    );
    if (!executionKey || currentExecutionKeys.has(executionKey)) continue;
    for (const sessionId of readLegacyExecutionEnvelope(backing, executionKey)
      ?.runners?.runnerSessionIds ?? []) {
      sessionIds.add(sessionId);
    }
  }
  for (const value of Object.values(readLegacyRunnerMap(backing))) {
    for (const sessionId of sanitizeRunners(value)?.runnerSessionIds ?? []) {
      sessionIds.add(sessionId);
    }
  }
  return sessionIds;
}

export function forgetStoredRunner(
  runnerSessionId: string,
  backing: Storage | null = defaultStorage()
): void {
  const executionKeys = new Set<string>();
  for (const storageKey of allStorageKeys(backing)) {
    const executionKey =
      executionKeyFromStorageKey(storageKey) ??
      executionKeyFromStorageKey(
        storageKey,
        LEGACY_EXECUTION_STORAGE_KEY_PREFIX
      );
    if (executionKey) executionKeys.add(executionKey);
  }
  for (const executionKey of executionKeys) {
    const envelope = readEnvelope(backing, executionKey);
    const current = envelope?.runners;
    if (!envelope) continue;
    const removesRunner = Boolean(
      current?.runnerSessionIds.includes(runnerSessionId)
    );
    const currentContinuation = activeEpisode(envelope.continuationLineage);
    const removesContinuation =
      currentContinuation?.continuationSessionId === runnerSessionId;
    if (!removesRunner && !removesContinuation) continue;
    if (current && removesRunner) {
      const runnerSessionIds = current.runnerSessionIds.filter(
        (sessionId) => sessionId !== runnerSessionId
      );
      if (runnerSessionIds.length === 0) {
        delete envelope.runners;
      } else {
        envelope.runners = {
          ...current,
          runnerSessionIds,
          terminalRunnerSessionIds: current.terminalRunnerSessionIds.filter(
            (sessionId) => sessionId !== runnerSessionId
          ),
        };
      }
    }
    if (removesContinuation && envelope.continuationLineage) {
      const now = new Date().toISOString();
      currentContinuation.state = "failed";
      currentContinuation.rollReason ??= "runner_deleted";
      currentContinuation.updatedAt = now;
      delete envelope.continuationLineage.activeEpisodeId;
      envelope.continuationLineage.updatedAt = now;
    }
    writeEnvelope(backing, executionKey, envelope);
  }

  if (!backing) return;
  const legacy = readLegacyRunnerMap(backing);
  let legacyChanged = false;
  for (const [key, value] of Object.entries(legacy)) {
    const current = sanitizeRunners(value);
    if (!current?.runnerSessionIds.includes(runnerSessionId)) continue;
    legacyChanged = true;
    const runnerSessionIds = current.runnerSessionIds.filter(
      (sessionId) => sessionId !== runnerSessionId
    );
    if (runnerSessionIds.length === 0) {
      delete legacy[key];
    } else {
      legacy[key] = {
        ...current,
        runnerSessionIds,
        terminalRunnerSessionIds: current.terminalRunnerSessionIds.filter(
          (sessionId) => sessionId !== runnerSessionId
        ),
      };
    }
  }
  if (!legacyChanged) return;
  try {
    if (Object.keys(legacy).length === 0) {
      backing.removeItem(LEGACY_RUNNERS_KEY);
    } else {
      backing.setItem(LEGACY_RUNNERS_KEY, JSON.stringify(legacy));
    }
  } catch {
    // Best-effort cleanup mirrors current-entry writes.
  }
}

export const __CONVERSATION_EXECUTION_STORE_INTERNALS = {
  STORE_VERSION,
  STORAGE_KEY_PREFIX,
  LEGACY_EXECUTION_STORE_VERSION,
  LEGACY_EXECUTION_STORAGE_KEY_PREFIX,
  LEGACY_RUNNERS_KEY,
  entryStorageKey,
  legacyEntryStorageKey,
};
