import type { DiagnosticsRuntimeSummary } from "./types";

interface RuntimeCounter {
  total: number;
  failure: number;
  totalDurationMs: number;
  durationHistogram: number[];
}

const MAX_RUNTIME_OPERATIONS = 128;
const OTHER_OPERATION = "__other__";
const DURATION_BUCKETS = [
  { upperBoundMs: 1, label: "lt_1ms" },
  { upperBoundMs: 5, label: "1_5ms" },
  { upperBoundMs: 20, label: "5_20ms" },
  { upperBoundMs: 100, label: "20_100ms" },
  { upperBoundMs: 500, label: "100_500ms" },
  { upperBoundMs: 2_000, label: "500ms_2s" },
  { upperBoundMs: Number.POSITIVE_INFINITY, label: "2s_plus" },
] as const;

const rpcCounters = new Map<string, RuntimeCounter>();
const httpCounters = new Map<string, RuntimeCounter>();

function createCounter(): RuntimeCounter {
  return {
    total: 0,
    failure: 0,
    totalDurationMs: 0,
    durationHistogram: Array.from({ length: DURATION_BUCKETS.length }, () => 0),
  };
}

function getCounter(
  counters: Map<string, RuntimeCounter>,
  operation: string
): RuntimeCounter {
  const existing = counters.get(operation);
  if (existing) return existing;

  const boundedOperation =
    counters.size < MAX_RUNTIME_OPERATIONS - 1 ? operation : OTHER_OPERATION;
  const overflow = counters.get(boundedOperation);
  if (overflow) return overflow;

  const created = createCounter();
  counters.set(boundedOperation, created);
  return created;
}

function normalizeDuration(durationMs: number): number {
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
}

function durationBucketIndex(durationMs: number): number {
  const index = DURATION_BUCKETS.findIndex(
    ({ upperBoundMs }) => durationMs < upperBoundMs
  );
  return index === -1 ? DURATION_BUCKETS.length - 1 : index;
}

function recordCounter(
  counter: RuntimeCounter,
  durationMs: number,
  ok: boolean
): void {
  const normalizedDurationMs = normalizeDuration(durationMs);
  counter.total += 1;
  counter.totalDurationMs += normalizedDurationMs;
  counter.durationHistogram[durationBucketIndex(normalizedDurationMs)] += 1;
  if (!ok) counter.failure += 1;
}

export function recordDiagnosticsRpc(
  command: string,
  durationMs: number,
  ok: boolean
): void {
  const counter = getCounter(rpcCounters, command);
  recordCounter(counter, durationMs, ok);
}

export function recordDiagnosticsHttp(
  target: string,
  durationMs: number,
  ok: boolean
): void {
  const counter = getCounter(httpCounters, target);
  recordCounter(counter, durationMs, ok);
}

function bucketLabelForDuration(durationMs: number): string {
  return DURATION_BUCKETS[durationBucketIndex(durationMs)].label;
}

function percentileBucket(histogram: number[], total: number): string {
  if (total === 0) return DURATION_BUCKETS[0].label;
  const target = Math.ceil(total * 0.95);
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= target) return DURATION_BUCKETS[index].label;
  }
  return DURATION_BUCKETS[DURATION_BUCKETS.length - 1].label;
}

function consumeDiagnosticsSummary(
  counters: Map<string, RuntimeCounter>
): DiagnosticsRuntimeSummary {
  let total = 0;
  let failure = 0;
  const byOperation: DiagnosticsRuntimeSummary["byOperation"] = {};

  for (const [operation, counter] of counters) {
    total += counter.total;
    failure += counter.failure;
    byOperation[operation] = {
      total: counter.total,
      success: counter.total - counter.failure,
      failure: counter.failure,
      averageDurationBucket: bucketLabelForDuration(
        counter.total === 0 ? 0 : counter.totalDurationMs / counter.total
      ),
      p95DurationBucket: percentileBucket(
        counter.durationHistogram,
        counter.total
      ),
    };
  }

  counters.clear();
  return { total, success: total - failure, failure, byOperation };
}

export function consumeRpcDiagnosticsSummary(): DiagnosticsRuntimeSummary {
  return consumeDiagnosticsSummary(rpcCounters);
}

export function consumeHttpDiagnosticsSummary(): DiagnosticsRuntimeSummary {
  return consumeDiagnosticsSummary(httpCounters);
}

export function discardRuntimeDiagnosticsCounters(): void {
  consumeRpcDiagnosticsSummary();
  consumeHttpDiagnosticsSummary();
}
