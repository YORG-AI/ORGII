/**
 * User Timing instrumentation for the singleton session pipeline.
 *
 * The marks stay available in browser/WebView performance tooling, but their
 * retention is deliberately bounded: one active trace plus the latest
 * completed traces. This module never persists data and never starts a timer,
 * observer, subscription, or background loop.
 */

export const SESSION_SWITCH_PERFORMANCE_PREFIX = "orgii:session-switch";

const MAX_COMPLETED_TRACES = 20;
const JOIN_EXISTING_TRACE_WINDOW_MS = 10_000;

export type SessionSwitchTraceSource =
  | "pipeline-effect"
  | "secondary-claim"
  | "session-jump"
  | "workstation-tab";

export type SessionSwitchTraceStage =
  | "data-ready"
  | "display-events-read"
  | "event-handler-ready"
  | "memory-events-read"
  | "no-adapter-load-start"
  | "orchestrator-start"
  | "persisted-history-complete"
  | "pipeline-selected"
  | "post-load-complete"
  | "rust-hydration-complete"
  | "rust-switch-complete"
  | "state-clear-start"
  | "state-cleared"
  | "state-commit-complete"
  | "state-commit-start"
  | "switch-state-reset"
  | "turn-window-complete"
  | "workstation-focus-persisted";

export type SessionSwitchTraceOutcome =
  | "aborted"
  | "failed"
  | "painted"
  | "superseded";

type TraceDetail = Record<string, boolean | number | string | null | undefined>;

interface SessionSwitchTrace {
  id: string;
  sessionId: string;
  source: SessionSwitchTraceSource;
  startMarkName: string;
  lastMarkName: string;
  entryNames: Set<string>;
  stageCounts: Map<string, number>;
  startedAtMs: number;
}

let traceSequence = 0;
let activeTrace: SessionSwitchTrace | null = null;
const completedTraces: SessionSwitchTrace[] = [];

function getUserTiming(): Performance | null {
  if (typeof performance === "undefined") return null;
  if (
    typeof performance.mark !== "function" ||
    typeof performance.measure !== "function"
  ) {
    return null;
  }
  return performance;
}

function createEntryDetail(
  trace: SessionSwitchTrace,
  stage: string,
  detail?: TraceDetail
): TraceDetail {
  return {
    traceId: trace.id,
    sessionId: trace.sessionId,
    source: trace.source,
    stage,
    ...detail,
  };
}

function safeMark(
  timing: Performance,
  name: string,
  detail: TraceDetail
): boolean {
  try {
    timing.mark(name, { detail });
    return true;
  } catch {
    try {
      timing.mark(name);
      return true;
    } catch {
      return false;
    }
  }
}

function safeMeasure(
  timing: Performance,
  name: string,
  start: string,
  end: string,
  detail: TraceDetail
): boolean {
  try {
    timing.measure(name, { start, end, detail });
    return true;
  } catch {
    try {
      timing.measure(name, start, end);
      return true;
    } catch {
      return false;
    }
  }
}

function clearTraceEntries(trace: SessionSwitchTrace): void {
  const timing = getUserTiming();
  if (!timing) return;
  for (const name of trace.entryNames) {
    timing.clearMarks?.(name);
    timing.clearMeasures?.(name);
  }
}

function retainCompletedTrace(trace: SessionSwitchTrace): void {
  completedTraces.push(trace);
  while (completedTraces.length > MAX_COMPLETED_TRACES) {
    const expired = completedTraces.shift();
    if (expired) clearTraceEntries(expired);
  }
}

function recordStage(
  trace: SessionSwitchTrace,
  stage: string,
  detail?: TraceDetail
): void {
  const timing = getUserTiming();
  if (!timing) return;

  const occurrence = (trace.stageCounts.get(stage) ?? 0) + 1;
  trace.stageCounts.set(stage, occurrence);
  const stageKey = occurrence === 1 ? stage : `${stage}-${occurrence}`;
  const markName = `${SESSION_SWITCH_PERFORMANCE_PREFIX}:${trace.id}:mark:${stageKey}`;
  const entryDetail = createEntryDetail(trace, stage, detail);
  if (!safeMark(timing, markName, entryDetail)) return;
  trace.entryNames.add(markName);

  const totalMeasureName = `${SESSION_SWITCH_PERFORMANCE_PREFIX}:${trace.id}:total-to:${stageKey}`;
  if (
    safeMeasure(
      timing,
      totalMeasureName,
      trace.startMarkName,
      markName,
      entryDetail
    )
  ) {
    trace.entryNames.add(totalMeasureName);
  }

  const segmentMeasureName = `${SESSION_SWITCH_PERFORMANCE_PREFIX}:${trace.id}:segment:${stageKey}`;
  if (
    safeMeasure(
      timing,
      segmentMeasureName,
      trace.lastMarkName,
      markName,
      entryDetail
    )
  ) {
    trace.entryNames.add(segmentMeasureName);
  }
  trace.lastMarkName = markName;
}

function finishTrace(
  trace: SessionSwitchTrace,
  outcome: SessionSwitchTraceOutcome,
  detail?: TraceDetail
): void {
  recordStage(trace, outcome, detail);
  if (activeTrace === trace) activeTrace = null;
  retainCompletedTrace(trace);
}

/**
 * Start a new trace, or join the active trace when a later lifecycle owner
 * sees the same session switch (for example WorkStation click → ChatView claim).
 */
export function startSessionSwitchTrace(
  sessionId: string,
  source: SessionSwitchTraceSource,
  options: { joinExisting?: boolean } = {}
): string | null {
  const timing = getUserTiming();
  if (!timing || !sessionId) return null;

  if (
    options.joinExisting &&
    activeTrace?.sessionId === sessionId &&
    Date.now() - activeTrace.startedAtMs <= JOIN_EXISTING_TRACE_WINDOW_MS
  ) {
    return activeTrace.id;
  }

  if (activeTrace) {
    finishTrace(activeTrace, "superseded", { nextSessionId: sessionId });
  }

  traceSequence += 1;
  const id = String(traceSequence).padStart(6, "0");
  const startMarkName = `${SESSION_SWITCH_PERFORMANCE_PREFIX}:${id}:mark:start`;
  const trace: SessionSwitchTrace = {
    id,
    sessionId,
    source,
    startMarkName,
    lastMarkName: startMarkName,
    entryNames: new Set([startMarkName]),
    stageCounts: new Map(),
    startedAtMs: Date.now(),
  };
  const marked = safeMark(
    timing,
    startMarkName,
    createEntryDetail(trace, "start")
  );
  if (!marked) return null;
  activeTrace = trace;
  return id;
}

export function hasActiveSessionSwitchTrace(sessionId: string): boolean {
  return activeTrace?.sessionId === sessionId;
}

export function markSessionSwitchTrace(
  sessionId: string,
  stage: SessionSwitchTraceStage,
  detail?: TraceDetail
): void {
  if (!activeTrace || activeTrace.sessionId !== sessionId) return;
  recordStage(activeTrace, stage, detail);
}

export function finishSessionSwitchTrace(
  sessionId: string,
  outcome: SessionSwitchTraceOutcome,
  detail?: TraceDetail
): void {
  if (!activeTrace || activeTrace.sessionId !== sessionId) return;
  finishTrace(activeTrace, outcome, detail);
}

/** Test-only reset for deterministic module-global retention assertions. */
export function resetSessionSwitchPerformanceForTests(): void {
  if (activeTrace) clearTraceEntries(activeTrace);
  for (const trace of completedTraces) clearTraceEntries(trace);
  activeTrace = null;
  completedTraces.length = 0;
  traceSequence = 0;
}
