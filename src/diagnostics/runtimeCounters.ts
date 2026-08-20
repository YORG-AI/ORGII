import { bucketDurationMs } from "./buckets";
import type { DiagnosticsRuntimeSummary } from "./types";

/**
 * Per-operation counter. Durations are folded into a running sum + sample
 * count rather than an array: the summary only ever needs the average, and
 * an array here grew unbounded (one entry per RPC/HTTP call) until a
 * consumer drained it — which offline mode never does.
 */
interface RuntimeCounter {
  total: number;
  failure: number;
  durationSumMs: number;
  durationSamples: number;
}

const rpcCounters = new Map<string, RuntimeCounter>();
const httpCounters = new Map<string, RuntimeCounter>();

function getCounter(
  counters: Map<string, RuntimeCounter>,
  operation: string
): RuntimeCounter {
  const existing = counters.get(operation);
  if (existing) return existing;
  const created: RuntimeCounter = {
    total: 0,
    failure: 0,
    durationSumMs: 0,
    durationSamples: 0,
  };
  counters.set(operation, created);
  return created;
}

export function recordDiagnosticsRpc(
  command: string,
  durationMs: number,
  ok: boolean
): void {
  const counter = getCounter(rpcCounters, command);
  counter.total += 1;
  if (!ok) counter.failure += 1;
  addDurationSample(counter, durationMs);
}

export function recordDiagnosticsHttp(
  target: string,
  durationMs: number,
  ok: boolean
): void {
  const counter = getCounter(httpCounters, target);
  counter.total += 1;
  if (!ok) counter.failure += 1;
  addDurationSample(counter, durationMs);
}

function addDurationSample(counter: RuntimeCounter, durationMs: number): void {
  if (!Number.isFinite(durationMs)) return;
  counter.durationSumMs += durationMs;
  counter.durationSamples += 1;
}

function averageDurationMs(counter: RuntimeCounter): number {
  if (counter.durationSamples === 0) return 0;
  return counter.durationSumMs / counter.durationSamples;
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
      durationBucket: bucketDurationMs(averageDurationMs(counter)),
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
