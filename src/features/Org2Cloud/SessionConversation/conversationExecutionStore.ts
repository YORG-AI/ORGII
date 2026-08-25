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

interface ConversationExecutionEnvelope {
  version: typeof STORE_VERSION;
  runners?: ConversationRunnerRegistryEntry;
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
  return {
    version: STORE_VERSION,
    ...(runners ? { runners } : {}),
  };
}

function writeRunners(
  backing: Storage | null,
  executionKey: string,
  runners: ConversationRunnerRegistryEntry | null
): void {
  if (!backing) return;
  try {
    if (!runners) {
      backing.removeItem(entryStorageKey(executionKey));
      return;
    }
    const envelope: ConversationExecutionEnvelope = {
      version: STORE_VERSION,
      runners,
    };
    backing.setItem(entryStorageKey(executionKey), JSON.stringify(envelope));
  } catch {
    // Best-effort: losing this registry only makes a plumbing row visible.
  }
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
  const normalized = normalizeExecutionKey(key);
  if (!normalized)
    throw new Error(`invalid conversation execution key: ${key}`);
  const current = readEnvelope(backing, normalized)?.runners;
  writeRunners(backing, normalized, {
    runnerSessionIds: [
      ...new Set([...(current?.runnerSessionIds ?? []), runnerSessionId]),
    ],
    terminalRunnerSessionIds: current?.terminalRunnerSessionIds ?? [],
    updatedAt,
  });
}

export function markStoredRunnerTerminal(
  key: string,
  runnerSessionId: string,
  backing: Storage | null = defaultStorage()
): void {
  const normalized = normalizeExecutionKey(key);
  if (!normalized) return;
  const current = readEnvelope(backing, normalized)?.runners;
  if (!current?.runnerSessionIds.includes(runnerSessionId)) return;
  writeRunners(backing, normalized, {
    ...current,
    terminalRunnerSessionIds: [
      ...new Set([...current.terminalRunnerSessionIds, runnerSessionId]),
    ],
    updatedAt: new Date().toISOString(),
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
    const current = readEnvelope(backing, executionKey)?.runners;
    if (!current?.runnerSessionIds.includes(runnerSessionId)) continue;
    const runnerSessionIds = current.runnerSessionIds.filter(
      (sessionId) => sessionId !== runnerSessionId
    );
    writeRunners(
      backing,
      executionKey,
      runnerSessionIds.length > 0
        ? {
            ...current,
            runnerSessionIds,
            terminalRunnerSessionIds: current.terminalRunnerSessionIds.filter(
              (sessionId) => sessionId !== runnerSessionId
            ),
          }
        : null
    );
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
