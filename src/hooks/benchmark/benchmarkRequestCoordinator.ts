import {
  type BenchmarkAgentBatchStatus,
  type BenchmarkKind,
  type BenchmarkRunStatus,
  type BenchmarkTaskDetail,
  type BenchmarkTaskIndexRow,
  benchmarkApi,
} from "@src/api/tauri/benchmark";

const STATUS_CACHE_MS = 1_900;
const MAX_STATUS_ENTRIES = 32;

interface SharedEntry<T> {
  fetchedAt?: number;
  generation?: number;
  inFlight?: Promise<T>;
  value?: T;
}

const taskRequests = new Map<string, SharedEntry<BenchmarkTaskIndexRow[]>>();
const taskDetailRequests = new Map<string, SharedEntry<BenchmarkTaskDetail>>();
const agentBatchHistoryRequests = new Map<
  string,
  SharedEntry<BenchmarkAgentBatchStatus[]>
>();
const agentBatchStatusRequests = new Map<
  string,
  SharedEntry<BenchmarkAgentBatchStatus>
>();
const runStatusRequests = new Map<string, SharedEntry<BenchmarkRunStatus>>();

function prune<T>(entries: Map<string, SharedEntry<T>>): void {
  if (entries.size <= MAX_STATUS_ENTRIES) return;
  const removable = [...entries.entries()]
    .filter(([, entry]) => !entry.inFlight)
    .sort(
      ([, left], [, right]) => (left.fetchedAt ?? 0) - (right.fetchedAt ?? 0)
    );
  for (const [key] of removable) {
    if (entries.size <= MAX_STATUS_ENTRIES) break;
    entries.delete(key);
  }
}

function sharedRequest<T>(
  entries: Map<string, SharedEntry<T>>,
  key: string,
  loader: () => Promise<T>,
  options?: { force?: boolean; maxAgeMs?: number }
): Promise<T> {
  const entry = entries.get(key) ?? {};
  if (entry.inFlight) return entry.inFlight;
  if (
    !options?.force &&
    entry.value !== undefined &&
    entry.fetchedAt !== undefined &&
    Date.now() - entry.fetchedAt < (options?.maxAgeMs ?? 0)
  ) {
    return Promise.resolve(entry.value);
  }

  const requestGeneration = entry.generation ?? 0;
  const request = loader().then((value) => {
    if (
      (entry.generation ?? 0) !== requestGeneration &&
      entry.value !== undefined
    ) {
      return entry.value;
    }
    return value;
  });
  entry.inFlight = request;
  entries.set(key, entry);
  void request.then(
    (value) => {
      if (entry.inFlight !== request) return;
      entry.value = value;
      entry.fetchedAt = Date.now();
      entry.inFlight = undefined;
      prune(entries);
    },
    () => {
      if (entry.inFlight === request) {
        entry.inFlight = undefined;
        if (entry.value === undefined) entries.delete(key);
      }
    }
  );
  return request;
}

function seedSharedEntry<T>(
  entries: Map<string, SharedEntry<T>>,
  key: string,
  value: T
): void {
  const entry = entries.get(key) ?? {};
  entry.generation = (entry.generation ?? 0) + 1;
  entry.inFlight = undefined;
  entry.value = value;
  entry.fetchedAt = Date.now();
  entries.set(key, entry);
  prune(entries);
}

export function listBenchmarkTasksShared(request: {
  kind: BenchmarkKind;
  limit: number;
  sourcePath: string;
}): Promise<BenchmarkTaskIndexRow[]> {
  const key = JSON.stringify([request.kind, request.sourcePath, request.limit]);
  return sharedRequest(taskRequests, key, () =>
    benchmarkApi.listTasks(request)
  );
}

export function getBenchmarkTaskShared(request: {
  kind: BenchmarkKind;
  sourcePath: string;
  taskId: string;
}): Promise<BenchmarkTaskDetail> {
  const key = JSON.stringify([
    request.kind,
    request.sourcePath,
    request.taskId,
  ]);
  return sharedRequest(taskDetailRequests, key, () =>
    benchmarkApi.getTask(request)
  );
}

export function listBenchmarkAgentBatchHistoriesShared(
  limit: number
): Promise<BenchmarkAgentBatchStatus[]> {
  return sharedRequest(
    agentBatchHistoryRequests,
    String(limit),
    () => benchmarkApi.listAgentBatchHistories({ limit }),
    { maxAgeMs: STATUS_CACHE_MS }
  );
}

export function getBenchmarkAgentBatchStatusShared(
  batchId: string,
  options?: { force?: boolean }
): Promise<BenchmarkAgentBatchStatus> {
  return sharedRequest(
    agentBatchStatusRequests,
    batchId,
    () => benchmarkApi.getAgentBatchStatus({ batchId }),
    { force: options?.force, maxAgeMs: STATUS_CACHE_MS }
  );
}

export function setBenchmarkAgentBatchStatusShared(
  status: BenchmarkAgentBatchStatus
): void {
  seedSharedEntry(agentBatchStatusRequests, status.batchId, status);
}

export function getBenchmarkRunStatusShared(
  runId: string,
  options?: { force?: boolean }
): Promise<BenchmarkRunStatus> {
  return sharedRequest(
    runStatusRequests,
    runId,
    () => benchmarkApi.getRunStatus({ runId }),
    { force: options?.force, maxAgeMs: STATUS_CACHE_MS }
  );
}

export function setBenchmarkRunStatusShared(status: BenchmarkRunStatus): void {
  seedSharedEntry(runStatusRequests, status.runId, status);
}

export const __TESTS_ONLY = {
  reset() {
    taskRequests.clear();
    taskDetailRequests.clear();
    agentBatchHistoryRequests.clear();
    agentBatchStatusRequests.clear();
    runStatusRequests.clear();
  },
};
