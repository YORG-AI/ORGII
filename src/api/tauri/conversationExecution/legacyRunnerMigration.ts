import { rpc } from "@src/api/tauri/rpc";

const CURRENT_ENTRY_PREFIX = "orgii:conversation-execution-v2:";
const PREVIOUS_ENTRY_PREFIX = "orgii:conversation-execution-v1:";
const GLOBAL_RUNNER_MAP_KEY = "orgii:conversation-runners-v1";
const CANONICAL_ROOT_TAG = "org2-conversation-root";
const CANONICAL_EXECUTOR_TAG = "org2-conversation-executor";

interface LegacyRunnerImportRequest {
  executorScope: string;
  conversationRootKey: string;
  runners: Array<{
    runnerSessionId: string;
    episodeId: string;
    terminal: boolean;
  }>;
}

export interface LegacyRunnerMigrationPlan {
  imports: LegacyRunnerImportRequest[];
  /** Entries skipped because their pre-generic root cannot be identified. */
  skippedNonCanonicalEntries: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
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

function canonicalExecutionKey(raw: string): {
  executorScope: string;
  conversationRootKey: string;
} | null {
  const parsed = parseJson(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string"
  ) {
    return null;
  }
  const executor = parseJson(parsed[0]);
  const root = parseJson(parsed[1]);
  if (
    !Array.isArray(executor) ||
    executor.length !== 4 ||
    executor[0] !== CANONICAL_EXECUTOR_TAG ||
    executor[1] !== 1 ||
    typeof executor[2] !== "string" ||
    executor[2].length === 0 ||
    !Array.isArray(executor[3]) ||
    !executor[3].every((part) => typeof part === "string" && part.length > 0) ||
    !Array.isArray(root) ||
    root.length !== 5 ||
    root[0] !== CANONICAL_ROOT_TAG ||
    root[1] !== 1 ||
    typeof root[2] !== "string" ||
    root[2].length === 0 ||
    !Array.isArray(root[3]) ||
    !root[3].every((part) => typeof part === "string" && part.length > 0) ||
    typeof root[4] !== "string" ||
    root[4].length === 0
  ) {
    return null;
  }
  return { executorScope: parsed[0], conversationRootKey: parsed[1] };
}

function executionKeyFromStorageKey(
  storageKey: string,
  prefix: string
): string | null {
  if (!storageKey.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(storageKey.slice(prefix.length));
  } catch {
    return null;
  }
}

function runnersFromEnvelope(
  envelope: unknown
): LegacyRunnerImportRequest["runners"] {
  if (!isObject(envelope) || !isObject(envelope.runners)) return [];
  const runnerSessionIds = strings(envelope.runners.runnerSessionIds);
  const registered = new Set(runnerSessionIds);
  const terminal = new Set(
    strings(envelope.runners.terminalRunnerSessionIds).filter((id) =>
      registered.has(id)
    )
  );
  return runnerSessionIds.map((runnerSessionId) => ({
    runnerSessionId,
    // The old registry did not own episode identity. Reusing the globally
    // unique ORG2 runner id is a stable registry-only association and avoids
    // importing an unpublished continuation draft by implication.
    episodeId: runnerSessionId,
    terminal: terminal.has(runnerSessionId),
  }));
}

function storageKeys(backing: Storage): string[] {
  const result: string[] = [];
  for (let index = 0; index < backing.length; index += 1) {
    const key = backing.key(index);
    if (key) result.push(key);
  }
  return result;
}

/**
 * Plan the only lossless migration from the localStorage state machine.
 *
 * Runner membership/terminality is generic and exact. Old continuation and
 * owner cursors were Cloud-plane sequence numbers, so this function never
 * imports episode pointers, prepared drafts, or cursor values. Entries whose
 * root predates the canonical tagged root key are skipped instead of guessed.
 */
export function planLegacyConversationRunnerMigration(
  backing: Storage
): LegacyRunnerMigrationPlan {
  const imports = new Map<string, LegacyRunnerImportRequest>();
  const currentExecutionKeys = new Set<string>();
  let skippedNonCanonicalEntries = 0;

  const ingest = (executionKey: string, envelope: unknown) => {
    const key = canonicalExecutionKey(executionKey);
    const runners = runnersFromEnvelope(envelope);
    if (!key) {
      if (runners.length > 0) skippedNonCanonicalEntries += 1;
      return;
    }
    const mapKey = JSON.stringify([key.executorScope, key.conversationRootKey]);
    const existing = imports.get(mapKey) ?? { ...key, runners: [] };
    const byRunner = new Map(
      existing.runners.map((runner) => [runner.runnerSessionId, runner])
    );
    runners.forEach((runner) => {
      const prior = byRunner.get(runner.runnerSessionId);
      if (!prior || (!prior.terminal && runner.terminal)) {
        byRunner.set(runner.runnerSessionId, runner);
      }
    });
    existing.runners = [...byRunner.values()].sort((left, right) =>
      left.runnerSessionId.localeCompare(right.runnerSessionId)
    );
    imports.set(mapKey, existing);
  };

  const keys = storageKeys(backing);
  keys.forEach((storageKey) => {
    const executionKey = executionKeyFromStorageKey(
      storageKey,
      CURRENT_ENTRY_PREFIX
    );
    if (!executionKey) return;
    const envelope = parseJson(backing.getItem(storageKey));
    if (!isObject(envelope) || envelope.version !== 2) return;
    currentExecutionKeys.add(executionKey);
    ingest(executionKey, envelope);
  });
  keys.forEach((storageKey) => {
    const executionKey = executionKeyFromStorageKey(
      storageKey,
      PREVIOUS_ENTRY_PREFIX
    );
    if (!executionKey || currentExecutionKeys.has(executionKey)) return;
    const envelope = parseJson(backing.getItem(storageKey));
    if (!isObject(envelope) || envelope.version !== 1) return;
    ingest(executionKey, envelope);
  });

  const globalMap = parseJson(backing.getItem(GLOBAL_RUNNER_MAP_KEY));
  if (isObject(globalMap)) {
    Object.entries(globalMap).forEach(([executionKey, runners]) => {
      ingest(executionKey, { runners });
    });
  }

  return {
    imports: [...imports.values()].filter((entry) => entry.runners.length > 0),
    skippedNonCanonicalEntries,
  };
}

/** Idempotently copy the lossless registry subset into SQLite. */
export async function importLegacyConversationRunnerMigration(
  backing: Storage
): Promise<LegacyRunnerMigrationPlan> {
  const plan = planLegacyConversationRunnerMigration(backing);
  for (const request of plan.imports) {
    await rpc.conversationExecution.importLegacyRunners({ request });
  }
  return plan;
}
