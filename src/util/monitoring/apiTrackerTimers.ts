import {
  getTrackingObservationStartedAtMs,
  isTrackingEnabled,
} from "./apiTrackerState";
import type {
  TimerFireEvent,
  TimerHotspot,
  TimerKind,
} from "./apiTrackerTypes";
import { extractFileInfo, getTimerStack } from "./apiTrackerUtils";
import {
  effectiveObservationWindowMs,
  ratePerMinuteInWindow,
} from "./hotspotRates";

const MAX_TIMER_EVENTS = 500;
const timerEvents: TimerFireEvent[] = [];

let timerTrackingPatched = false;

function addTimerEvent(event: TimerFireEvent): void {
  timerEvents.push(event);
  if (timerEvents.length > MAX_TIMER_EVENTS) {
    timerEvents.splice(0, timerEvents.length - MAX_TIMER_EVENTS);
  }
}

function captureTimerSource() {
  const stack = getTimerStack()
    .split("\n")
    .filter((line) => !line.includes("apiTrackerTimers.ts"))
    .join("\n");
  const fileInfo = extractFileInfo(stack);
  return { stack, fileInfo };
}

function recordTimerFire(
  id: string,
  kind: TimerKind,
  delayMs: number | undefined,
  source: ReturnType<typeof captureTimerSource>
): void {
  if (!isTrackingEnabled() || !source.fileInfo.filePath) return;

  addTimerEvent({
    id,
    kind,
    delayMs,
    timestamp: new Date().toISOString(),
    filePath: source.fileInfo.filePath,
    componentName: source.fileInfo.componentName,
    functionName: source.fileInfo.functionName,
    lineNumber: source.fileInfo.lineNumber,
    stack: source.stack,
  });
}

type TimerFunctionName = "setInterval" | "setTimeout" | "requestAnimationFrame";

type TimerPatchRecord = {
  name: TimerFunctionName;
  ownDescriptor?: PropertyDescriptor;
};

function setWindowTimerFunction(
  name: TimerFunctionName,
  value: unknown
): TimerPatchRecord | undefined {
  const ownDescriptor = Object.getOwnPropertyDescriptor(window, name);
  try {
    Object.defineProperty(window, name, {
      configurable: true,
      value,
      writable: true,
    });
    return { name, ownDescriptor };
  } catch {
    return undefined;
  }
}

function restoreWindowTimerFunction(record: TimerPatchRecord): void {
  try {
    if (record.ownDescriptor) {
      Object.defineProperty(window, record.name, record.ownDescriptor);
      return;
    }
    delete window[record.name];
  } catch {
    // Timer instrumentation must never take down the app during cleanup.
  }
}

export function installTimerTracking(): (() => void) | undefined {
  if (timerTrackingPatched || typeof window === "undefined") return undefined;

  const originalSetInterval = window.setInterval.bind(
    window
  ) as Window["setInterval"];
  const originalSetTimeout = window.setTimeout.bind(
    window
  ) as Window["setTimeout"];
  const originalRequestAnimationFrame =
    window.requestAnimationFrame.bind(window);

  const createWrappedTimerCallback = (
    timerId: string,
    kind: Extract<TimerKind, "interval" | "timeout">,
    delayMs: number | undefined,
    source: ReturnType<typeof captureTimerSource>,
    handler: TimerHandler
  ): TimerHandler => {
    if (typeof handler === "function") {
      return (...callbackArgs: unknown[]) => {
        recordTimerFire(timerId, kind, delayMs, source);
        handler(...callbackArgs);
      };
    }

    return () => {
      recordTimerFire(timerId, kind, delayMs, source);
      return Function(handler)();
    };
  };

  const patchedSetInterval = <TArgs extends unknown[]>(
    handler: TimerHandler,
    timeout?: number,
    ...args: TArgs
  ): number => {
    const timerId = `interval-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const source = captureTimerSource();
    const delayMs = typeof timeout === "number" ? timeout : undefined;
    return originalSetInterval(
      createWrappedTimerCallback(timerId, "interval", delayMs, source, handler),
      timeout,
      ...args
    );
  };

  const patchedSetTimeout = <TArgs extends unknown[]>(
    handler: TimerHandler,
    timeout?: number,
    ...args: TArgs
  ): number => {
    const timerId = `timeout-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const source = captureTimerSource();
    const delayMs = typeof timeout === "number" ? timeout : undefined;
    return originalSetTimeout(
      createWrappedTimerCallback(timerId, "timeout", delayMs, source, handler),
      timeout,
      ...args
    );
  };

  const patchedRequestAnimationFrame: typeof window.requestAnimationFrame = (
    callback
  ) => {
    const frameId = `raf-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    const source = captureTimerSource();
    return originalRequestAnimationFrame((timestamp) => {
      recordTimerFire(frameId, "raf", undefined, source);
      callback(timestamp);
    });
  };

  const patchRecords = [
    setWindowTimerFunction("setInterval", patchedSetInterval),
    setWindowTimerFunction("setTimeout", patchedSetTimeout),
    setWindowTimerFunction(
      "requestAnimationFrame",
      patchedRequestAnimationFrame
    ),
  ];

  if (patchRecords.some((record) => !record)) {
    for (const record of patchRecords) {
      if (record) restoreWindowTimerFunction(record);
    }
    return undefined;
  }

  timerTrackingPatched = true;

  return () => {
    for (const record of patchRecords) {
      if (record) restoreWindowTimerFunction(record);
    }
    timerTrackingPatched = false;
  };
}

function getTimerHotspotKey(event: TimerFireEvent): string {
  const source = event.filePath
    ? `${event.filePath}:${event.lineNumber ?? 0}`
    : event.componentName || event.functionName || "unknown-source";
  return `${event.kind}:${event.delayMs ?? "frame"}:${source}`;
}

export const getTimerEvents = (): TimerFireEvent[] => [...timerEvents];

export function getTimerHotspots(windowMs = 120_000): TimerHotspot[] {
  const now = Date.now();
  const observationWindowMs = effectiveObservationWindowMs(
    windowMs,
    getTrackingObservationStartedAtMs(),
    now
  );
  const recentEvents = timerEvents.filter((event) => {
    const timestamp = new Date(event.timestamp).getTime();
    return Number.isFinite(timestamp) && now - timestamp <= windowMs;
  });

  const grouped = new Map<string, TimerFireEvent[]>();
  for (const event of recentEvents) {
    const key = getTimerHotspotKey(event);
    const group = grouped.get(key);
    if (group) group.push(event);
    else grouped.set(key, [event]);
  }

  return Array.from(grouped.entries())
    .map(([key, events]) => {
      const sortedEvents = [...events].sort(
        (eventA, eventB) =>
          new Date(eventB.timestamp).getTime() -
          new Date(eventA.timestamp).getTime()
      );
      const latestEvent = sortedEvents[0];
      const timestamps = events.map((event) =>
        new Date(event.timestamp).getTime()
      );
      const firstMs = Math.min(...timestamps);
      const firesPerMinute = ratePerMinuteInWindow(
        events.length,
        observationWindowMs
      );

      return {
        key,
        kind: latestEvent.kind,
        delayMs: latestEvent.delayMs,
        count: events.length,
        firesPerMinute,
        lastTimestamp: latestEvent.timestamp,
        firstTimestamp: new Date(firstMs).toISOString(),
        componentName: latestEvent.componentName,
        functionName: latestEvent.functionName,
        filePath: latestEvent.filePath,
        lineNumber: latestEvent.lineNumber,
        stack: latestEvent.stack,
        isLikelyLoop:
          latestEvent.kind === "raf" ? events.length >= 10 : events.length >= 3,
      } satisfies TimerHotspot;
    })
    .sort((hotspotA, hotspotB) => {
      if (hotspotA.isLikelyLoop !== hotspotB.isLikelyLoop) {
        return hotspotA.isLikelyLoop ? -1 : 1;
      }
      return hotspotB.firesPerMinute - hotspotA.firesPerMinute;
    });
}

export function clearTimerEvents(): void {
  timerEvents.splice(0, timerEvents.length);
}
