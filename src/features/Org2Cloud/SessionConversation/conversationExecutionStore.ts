/**
 * The single local persistence boundary for shared-conversation execution.
 *
 * Each (executor scope, root session) has its own localStorage entry. Keeping
 * entries split prevents an unrelated conversation write in another desktop
 * window from replacing the whole registry blob. The legacy one-shot runner
 * blob remains readable so an upgrade never exposes plumbing sessions in My
 * Sessions.
 */

const STORE_VERSION = 1 as const;
const STORAGE_KEY_PREFIX = "orgii:conversation-execution-v1:";
const LEGACY_RUNNERS_KEY = "orgii:conversation-runners-v1";
const UNKNOWN_UPDATED_AT = "1970-01-01T00:00:00.000Z";

export interface ConversationRunnerRegistryEntry {
  runnerSessionIds: string[];
  terminalRunnerSessionIds: string[];
  updatedAt: string;
}

export interface ConversationContinuationRecord {
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

export interface ConversationPlaneReadCursor {
  readThroughPlaneSeq: number;
  updatedAt: string;
}

interface ConversationExecutionEnvelope {
  version: typeof STORE_VERSION;
  runners?: ConversationRunnerRegistryEntry;
  continuation?: ConversationContinuationRecord;
  /** Independent cursor for execution directly in the owner's root session. */
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

function executionKeyFromStorageKey(storageKey: string): string | null {
  if (!storageKey.startsWith(STORAGE_KEY_PREFIX)) return null;
  try {
    return normalizeExecutionKey(
      decodeURIComponent(storageKey.slice(STORAGE_KEY_PREFIX.length))
    );
  } catch {
    return null;
  }
}

function readEnvelope(
  backing: Storage | null,
  executionKey: string
): ConversationExecutionEnvelope | null {
  const parsed = readJson(backing, entryStorageKey(executionKey));
  if (!isObject(parsed) || parsed.version !== STORE_VERSION) return null;
  const runners = sanitizeRunners(parsed.runners);
  const continuation = sanitizeContinuation(parsed.continuation);
  const ownerPlaneCursor = sanitizePlaneCursor(parsed.ownerPlaneCursor);
  return {
    version: STORE_VERSION,
    ...(runners ? { runners } : {}),
    ...(continuation ? { continuation } : {}),
    ...(ownerPlaneCursor ? { ownerPlaneCursor } : {}),
  };
}

function hasExecutionData(envelope: ConversationExecutionEnvelope): boolean {
  return Boolean(
    envelope.runners || envelope.continuation || envelope.ownerPlaneCursor
  );
}

function writeEnvelope(
  backing: Storage | null,
  executionKey: string,
  envelope: ConversationExecutionEnvelope
): void {
  if (!backing) return;
  try {
    if (!hasExecutionData(envelope)) {
      backing.removeItem(entryStorageKey(executionKey));
      return;
    }
    backing.setItem(entryStorageKey(executionKey), JSON.stringify(envelope));
  } catch {
    // Best-effort: a failed local persistence write rolls through recovery.
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

export function conversationExecutionKey(
  executorScope: string,
  rootSessionId: string
): string {
  return JSON.stringify([executorScope, rootSessionId]);
}

/** One executor per signed-in cloud identity and organization. */
export function cloudConversationExecutorScopeKey(
  authIdentity: string,
  cloudOrgId: string
): string {
  return JSON.stringify([
    "cloud-conversation-executor",
    authIdentity,
    cloudOrgId,
  ]);
}

/** Execution setup is shared by every surface targeting this agent/root. */
export function cloudConversationSetupMemoryKey(
  authIdentity: string,
  cloudOrgId: string,
  rootSessionId: string,
  assignedAgentDefinitionId?: string
): string {
  return JSON.stringify([
    "cloud-conversation-setup",
    authIdentity,
    cloudOrgId,
    rootSessionId,
    assignedAgentDefinitionId ?? "unassigned",
  ]);
}

function keyFor(executorScope: string, rootSessionId: string): string {
  return conversationExecutionKey(executorScope, rootSessionId);
}

export function loadStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): ConversationContinuationRecord | null {
  const key = keyFor(executorScope, rootSessionId);
  return readEnvelope(backing, key)?.continuation ?? null;
}

function assertValidContinuationRecord(
  record: Omit<ConversationContinuationRecord, "updatedAt">
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
  record: Omit<ConversationContinuationRecord, "updatedAt">,
  backing: Storage | null = defaultStorage()
): void {
  assertValidContinuationRecord(record);
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    envelope.continuation = {
      ...record,
      updatedAt: new Date().toISOString(),
    };
    return true;
  });
}

/** Atomically hide a newly created runner and install its continuation. */
export function prepareStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  record: Omit<ConversationContinuationRecord, "updatedAt">,
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
    envelope.continuation = { ...record, updatedAt: preparedAt };
    return true;
  });
}

export function clearStoredContinuation(
  executorScope: string,
  rootSessionId: string,
  backing: Storage | null = defaultStorage()
): void {
  mutateEnvelope(backing, keyFor(executorScope, rootSessionId), (envelope) => {
    if (!envelope.continuation) return false;
    delete envelope.continuation;
    return true;
  });
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
    const continuation = envelope.continuation;
    if (
      !continuation ||
      continuation.continuationSessionId !== continuationSessionId ||
      continuation.established ||
      continuation.bootstrapTurnIntentId !== bootstrapTurnIntentId
    ) {
      return false;
    }
    continuation.established = true;
    delete continuation.bootstrapTurnIntentId;
    continuation.updatedAt = new Date().toISOString();
    established = true;
    return true;
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
    const continuation = envelope.continuation;
    if (!continuation || continuation.readThroughPlaneSeq >= planeSeq) {
      return false;
    }
    continuation.readThroughPlaneSeq = planeSeq;
    continuation.updatedAt = new Date().toISOString();
    return true;
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
  for (const storageKey of allStorageKeys(backing)) {
    const executionKey = executionKeyFromStorageKey(storageKey);
    if (!executionKey) continue;
    for (const sessionId of readEnvelope(backing, executionKey)?.runners
      ?.runnerSessionIds ?? []) {
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
  for (const storageKey of allStorageKeys(backing)) {
    const executionKey = executionKeyFromStorageKey(storageKey);
    if (!executionKey) continue;
    const envelope = readEnvelope(backing, executionKey);
    const current = envelope?.runners;
    if (!envelope) continue;
    const removesRunner = Boolean(
      current?.runnerSessionIds.includes(runnerSessionId)
    );
    const removesContinuation =
      envelope.continuation?.continuationSessionId === runnerSessionId;
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
    if (removesContinuation) {
      delete envelope.continuation;
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
  LEGACY_RUNNERS_KEY,
  entryStorageKey,
};
