import axios, { AxiosResponse, InternalAxiosRequestConfig } from "axios";

import {
  extractFileInfo,
  generateRequestId,
  getApiStack,
  getComponentInfo,
  getTauriStack,
  getTimerStack,
} from "./apiTrackerUtils";
import { ratePerMinuteInWindow, spansRepeatedActivity } from "./hotspotRates";

// Extended axios config with tracking properties
interface TrackedAxiosConfig extends InternalAxiosRequestConfig {
  __requestId?: string;
  __captureId?: string;
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}

type TauriInternalsHost = {
  __TAURI_INTERNALS__?: TauriInternals;
};

export type InteractionType =
  | "auto"
  | "click"
  | "hover"
  | "keyboard"
  | "focus"
  | "unknown";

export type BackendType = "python" | "rust";

export interface ApiCall {
  id: string;
  method: string;
  url: string;
  fullUrl: string;
  backend: BackendType;
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  data?: unknown;
  status?: number;
  statusText?: string;
  response?: unknown;
  error?: unknown;
  duration?: number;
  timestamp: string;
  componentSelector?: string;
  componentLabel?: string;
  interactionType?: InteractionType;
  filePath?: string;
  componentName?: string;
  functionName?: string;
  lineNumber?: number;
  stack?: string;
  tauriCommand?: string;
  tauriArgs?: unknown;
}

let apiCalls: ApiCall[] = [];
let trackingEnabled = false;
let tracingModeEnabled = false;
const requestStartTimes = new Map<string, number>();
const MAX_API_CALLS = 300;
const MAX_TIMER_EVENTS = 500;

export type TimerKind = "interval" | "timeout" | "raf";

export interface TimerFireEvent {
  id: string;
  kind: TimerKind;
  delayMs?: number;
  timestamp: string;
  filePath?: string;
  componentName?: string;
  functionName?: string;
  lineNumber?: number;
  stack?: string;
}

export interface TimerHotspot {
  key: string;
  kind: TimerKind;
  delayMs?: number;
  count: number;
  firesPerMinute: number;
  lastTimestamp: string;
  firstTimestamp: string;
  componentName?: string;
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  stack?: string;
  isLikelyLoop: boolean;
}

const timerEvents: TimerFireEvent[] = [];

// Track recent user interactions to determine interaction type
let recentInteraction: {
  type: InteractionType;
  timestamp: number;
} | null = null;

const INTERACTION_WINDOW_MS = 500; // Consider interactions within 500ms as related

// Detect interaction type from recent events
const detectInteractionType = (): InteractionType => {
  if (!recentInteraction) return "auto";

  const timeSinceInteraction = Date.now() - recentInteraction.timestamp;
  if (timeSinceInteraction > INTERACTION_WINDOW_MS) {
    return "auto";
  }

  return recentInteraction.type;
};

// Track user interactions with named handlers (removable)
function trackClick() {
  recentInteraction = { type: "click", timestamp: Date.now() };
}
function trackHover() {
  recentInteraction = { type: "hover", timestamp: Date.now() };
}
function trackKeyboard() {
  recentInteraction = { type: "keyboard", timestamp: Date.now() };
}
function trackFocus() {
  recentInteraction = { type: "focus", timestamp: Date.now() };
}

/** Remove all interaction tracking listeners (call on app teardown) */
export function cleanupInteractionTracking() {
  document.removeEventListener("click", trackClick, true);
  document.removeEventListener("mouseover", trackHover, true);
  document.removeEventListener("keydown", trackKeyboard, true);
  document.removeEventListener("focus", trackFocus, true);
}

// Store pending call info (captured before axios processes the request)
const pendingCallInfo = new Map<
  string,
  {
    stack: string;
    fileInfo: ReturnType<typeof extractFileInfo>;
    componentInfo: ReturnType<typeof getComponentInfo>;
  }
>();

/**
 * Capture API call stack at the point of calling the API function.
 * This should be called from apiConfig.ts before the axios request is made.
 * Returns a capture ID that should be passed to the axios config.
 */
export const captureApiCallStack = (): string => {
  const captureId = `capture-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

  if (!trackingEnabled) return captureId;

  const stack = getApiStack();
  const fileInfo = extractFileInfo(stack);
  const componentInfo = getComponentInfo();

  pendingCallInfo.set(captureId, { stack, fileInfo, componentInfo });

  // Clean up old entries after 5 seconds (in case request never completes)
  setTimeout(() => {
    pendingCallInfo.delete(captureId);
  }, 5000);

  return captureId;
};

// Initialize axios interceptors
let interceptorsInitialized = false;

export const initializeApiTracking = (): (() => void) | undefined => {
  if (interceptorsInitialized || typeof window === "undefined")
    return undefined;

  // Request interceptor
  const requestInterceptor = axios.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
      if (!trackingEnabled) return config;

      const requestId = generateRequestId();
      const startTime = Date.now();
      requestStartTimes.set(requestId, startTime);

      // Store request ID in config for response matching
      (config as TrackedAxiosConfig).__requestId = requestId;

      // Check if we have pre-captured info from wrapper
      const preCaptured = pendingCallInfo.get(
        (config as TrackedAxiosConfig).__captureId ?? ""
      );
      if (preCaptured) {
        pendingCallInfo.delete(
          (config as TrackedAxiosConfig).__captureId ?? ""
        );
      }

      // Get component info at request time (fallback)
      const componentInfo = preCaptured?.componentInfo || getComponentInfo();
      const stack = preCaptured?.stack || getApiStack();
      const fileInfo = preCaptured?.fileInfo || extractFileInfo(stack);

      const apiCall: ApiCall = {
        id: requestId,
        method: (config.method || "GET").toUpperCase(),
        url: config.url || "",
        fullUrl: config.baseURL
          ? `${config.baseURL}${config.url}`
          : config.url || "",
        backend: "python",
        headers: config.headers as Record<string, string>,
        params: config.params,
        data: config.data,
        timestamp: new Date().toISOString(),
        componentSelector: componentInfo.selector,
        componentLabel: componentInfo.label,
        interactionType: detectInteractionType(),
        filePath: fileInfo.filePath,
        componentName: fileInfo.componentName,
        functionName: fileInfo.functionName,
        lineNumber: fileInfo.lineNumber,
        stack,
      };

      // Add to calls list
      apiCalls.unshift(apiCall);
      if (apiCalls.length > MAX_API_CALLS) {
        apiCalls = apiCalls.slice(0, MAX_API_CALLS);
      }

      // Dispatch event for real-time updates when tracing mode is enabled
      if (tracingModeEnabled) {
        window.dispatchEvent(
          new CustomEvent("api-call-updated", {
            detail: { apiCall, totalCalls: apiCalls.length },
          })
        );
      }

      return config;
    },
    (error) => {
      return Promise.reject(error);
    }
  );

  // Response interceptor
  const responseInterceptor = axios.interceptors.response.use(
    (response: AxiosResponse) => {
      if (!trackingEnabled) return response;

      const requestId = (response.config as TrackedAxiosConfig).__requestId;
      if (requestId) {
        const startTime = requestStartTimes.get(requestId);
        const duration = startTime ? Date.now() - startTime : undefined;
        requestStartTimes.delete(requestId);

        // Update API call with response
        const apiCall = apiCalls.find((call) => call.id === requestId);
        if (apiCall) {
          apiCall.status = response.status;
          apiCall.statusText = response.statusText;
          apiCall.response = response.data;
          apiCall.duration = duration;

          // Dispatch event for real-time updates when tracing mode is enabled
          if (tracingModeEnabled) {
            window.dispatchEvent(
              new CustomEvent("api-call-updated", {
                detail: { apiCall, totalCalls: apiCalls.length },
              })
            );
          }
        }
      }

      return response;
    },
    (error) => {
      if (!trackingEnabled) return Promise.reject(error);

      const requestId = (error.config as TrackedAxiosConfig | undefined)
        ?.__requestId;
      if (requestId) {
        const startTime = requestStartTimes.get(requestId);
        const duration = startTime ? Date.now() - startTime : undefined;
        requestStartTimes.delete(requestId);

        // Update API call with error
        const apiCall = apiCalls.find((call) => call.id === requestId);
        if (apiCall) {
          apiCall.status = error.response?.status;
          apiCall.statusText = error.response?.statusText;
          apiCall.error = error.response?.data || error.message;
          apiCall.duration = duration;

          // Dispatch event for real-time updates when tracing mode is enabled
          if (tracingModeEnabled) {
            window.dispatchEvent(
              new CustomEvent("api-call-updated", {
                detail: { apiCall, totalCalls: apiCalls.length },
              })
            );
          }
        }
      }

      return Promise.reject(error);
    }
  );

  interceptorsInitialized = true;

  // Return cleanup function
  return () => {
    axios.interceptors.request.eject(requestInterceptor);
    axios.interceptors.response.eject(responseInterceptor);
    interceptorsInitialized = false;
  };
};

let timerTrackingPatched = false;

function addTimerEvent(event: TimerFireEvent): void {
  timerEvents.push(event);
  if (timerEvents.length > MAX_TIMER_EVENTS) {
    timerEvents.splice(0, timerEvents.length - MAX_TIMER_EVENTS);
  }
}

function captureTimerSource() {
  const stack = getTimerStack();
  const fileInfo = extractFileInfo(stack);
  return { stack, fileInfo };
}

function recordTimerFire(
  id: string,
  kind: TimerKind,
  delayMs: number | undefined,
  source: ReturnType<typeof captureTimerSource>
): void {
  if (!trackingEnabled || !source.fileInfo.filePath) return;

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

function installTimerTracking(): (() => void) | undefined {
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

// ============================================
// Native fetch() tracking
//
// axios interceptors only see axios traffic, but a large share of backend
// calls (IDE server on :13847 — git status, file content, tab verification,
// SSE bootstraps) go through bare `fetch()`. Patch it while tracking is
// enabled so those calls appear in the panel too.
// ============================================

let fetchTrackingPatched = false;

function describeFetchTarget(input: RequestInfo | URL): {
  url: string;
  method?: string;
} {
  if (typeof input === "string") return { url: input };
  if (input instanceof URL) return { url: input.href };
  return { url: input.url, method: input.method };
}

function isFetchNoise(url: string): boolean {
  // webpack HMR manifests/chunks would drown real API traffic in dev.
  return url.includes("hot-update") || url.includes("__webpack");
}

function installFetchTracking(): (() => void) | undefined {
  if (fetchTrackingPatched || typeof window === "undefined") return undefined;

  const originalFetch = window.fetch.bind(window);

  const patchedFetch: typeof window.fetch = async (input, init) => {
    const target = describeFetchTarget(input as RequestInfo | URL);
    if (!trackingEnabled || isFetchNoise(target.url)) {
      return originalFetch(input, init);
    }

    const requestId = generateRequestId();
    const stack = getApiStack();
    const fileInfo = extractFileInfo(stack);
    const componentInfo = getComponentInfo();
    const method = (init?.method || target.method || "GET").toUpperCase();

    const apiCall: ApiCall = {
      id: requestId,
      method,
      url: target.url,
      fullUrl: target.url,
      backend: "python",
      data: init?.body,
      timestamp: new Date().toISOString(),
      componentSelector: componentInfo.selector,
      componentLabel: componentInfo.label,
      interactionType: detectInteractionType(),
      filePath: fileInfo.filePath,
      componentName: fileInfo.componentName,
      functionName: fileInfo.functionName,
      lineNumber: fileInfo.lineNumber,
      stack,
    };
    apiCalls.unshift(apiCall);
    if (apiCalls.length > MAX_API_CALLS) {
      apiCalls = apiCalls.slice(0, MAX_API_CALLS);
    }
    requestStartTimes.set(requestId, Date.now());

    const finish = (status?: number, statusText?: string, error?: unknown) => {
      const startTime = requestStartTimes.get(requestId);
      apiCall.duration = startTime ? Date.now() - startTime : undefined;
      requestStartTimes.delete(requestId);
      apiCall.status = status;
      apiCall.statusText = statusText;
      if (error !== undefined) apiCall.error = error;
      if (tracingModeEnabled) {
        window.dispatchEvent(
          new CustomEvent("api-call-updated", {
            detail: { apiCall, totalCalls: apiCalls.length },
          })
        );
      }
    };

    try {
      const response = await originalFetch(input, init);
      finish(response.status, response.statusText);
      return response;
    } catch (error) {
      finish(undefined, "Network Error", error);
      throw error;
    }
  };

  try {
    Object.defineProperty(window, "fetch", {
      configurable: true,
      value: patchedFetch,
      writable: true,
    });
  } catch {
    return undefined;
  }
  fetchTrackingPatched = true;

  return () => {
    try {
      Object.defineProperty(window, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    } finally {
      fetchTrackingPatched = false;
    }
  };
}

// ============================================
// Push-traffic tracking (backend → frontend)
//
// invoke/fetch tracking only sees frontend-INITIATED calls. A lot of load
// arrives as pushes: Tauri events (`listen`), IPC channels, WebSocket and
// SSE messages. Dispatch chokepoints call `recordPushEvent`, and the panel
// aggregates them into per-name rates so "the backend is streaming X at
// N/min" is visible next to the polling hotspots.
// ============================================

export type PushKind = "tauri-event" | "channel" | "ws" | "sse";

interface PushEvent {
  kind: PushKind;
  name: string;
  timestampMs: number;
}

export interface PushHotspot {
  key: string;
  kind: PushKind;
  name: string;
  count: number;
  eventsPerMinute: number;
  lastTimestamp: string;
  firstTimestamp: string;
  isLikelyStream: boolean;
}

const MAX_PUSH_EVENTS = 2000;
const pushEvents: PushEvent[] = [];

/**
 * Record one backend-push delivery (Tauri event, IPC channel message,
 * WebSocket message, SSE event). Cheap no-op while tracking is disabled —
 * safe to call from hot dispatch paths.
 */
export function recordPushEvent(kind: PushKind, name: string): void {
  if (!trackingEnabled) return;
  pushEvents.push({ kind, name, timestampMs: Date.now() });
  if (pushEvents.length > MAX_PUSH_EVENTS) {
    pushEvents.splice(0, pushEvents.length - MAX_PUSH_EVENTS);
  }
}

export function getPushHotspots(windowMs = 120_000): PushHotspot[] {
  const now = Date.now();
  const recent = pushEvents.filter(
    (event) => now - event.timestampMs <= windowMs
  );

  const grouped = new Map<string, PushEvent[]>();
  for (const event of recent) {
    const key = `${event.kind}:${event.name}`;
    const group = grouped.get(key);
    if (group) group.push(event);
    else grouped.set(key, [event]);
  }

  return Array.from(grouped.entries())
    .map(([key, events]) => {
      const timestamps = events.map((event) => event.timestampMs);
      const firstMs = Math.min(...timestamps);
      const lastMs = Math.max(...timestamps);
      const eventsPerMinute = ratePerMinuteInWindow(events.length, windowMs);
      return {
        key,
        kind: events[0].kind,
        name: events[0].name,
        count: events.length,
        eventsPerMinute,
        lastTimestamp: new Date(lastMs).toISOString(),
        firstTimestamp: new Date(firstMs).toISOString(),
        isLikelyStream: events.length >= 10,
      } satisfies PushHotspot;
    })
    .sort((hotspotA, hotspotB) => {
      if (hotspotA.isLikelyStream !== hotspotB.isLikelyStream) {
        return hotspotA.isLikelyStream ? -1 : 1;
      }
      return hotspotB.eventsPerMinute - hotspotA.eventsPerMinute;
    });
}

let directTauriInvokePatched = false;
let directTauriInvokeSuppressionDepth = 0;

export async function withDirectTauriInvokeTrackingSuppressed<T>(
  operation: () => Promise<T>
): Promise<T> {
  directTauriInvokeSuppressionDepth += 1;
  try {
    return await operation();
  } finally {
    directTauriInvokeSuppressionDepth -= 1;
  }
}

function installDirectTauriInvokeTracking(): (() => void) | undefined {
  if (directTauriInvokePatched || typeof window === "undefined")
    return undefined;

  const tauriInternals = (window as TauriInternalsHost).__TAURI_INTERNALS__;
  const originalInvoke = tauriInternals?.invoke;
  if (!tauriInternals || !originalInvoke) return undefined;

  const patchedTauriInvoke = async (
    cmd: string,
    args?: unknown
  ): Promise<unknown> => {
    if (!trackingEnabled || directTauriInvokeSuppressionDepth > 0) {
      return originalInvoke(cmd, args);
    }

    const requestId = `tauri-direct-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    trackTauriInvoke(cmd, args, requestId);
    try {
      const result = await originalInvoke(cmd, args);
      trackTauriInvokeResult(requestId, result);
      return result;
    } catch (error) {
      trackTauriInvokeResult(requestId, undefined, error);
      throw error;
    }
  };

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    tauriInternals,
    "invoke"
  );

  try {
    Object.defineProperty(tauriInternals, "invoke", {
      configurable: true,
      value: patchedTauriInvoke,
      writable: true,
    });
  } catch {
    return undefined;
  }

  directTauriInvokePatched = true;

  return () => {
    try {
      if (originalDescriptor) {
        Object.defineProperty(tauriInternals, "invoke", originalDescriptor);
      } else {
        delete tauriInternals.invoke;
      }
    } finally {
      directTauriInvokePatched = false;
    }
  };
}

// Holds the cleanup returned by initializeApiTracking so interceptors can be
// ejected when tracking is disabled (previously the return value was discarded).
let cleanupInterceptors: (() => void) | undefined;
let cleanupDirectTauriInvokeTracking: (() => void) | undefined;
let cleanupTimerTracking: (() => void) | undefined;
let cleanupFetchTracking: (() => void) | undefined;

export const enableApiTracking = () => {
  trackingEnabled = true;
  cleanupInterceptors = initializeApiTracking();
  cleanupDirectTauriInvokeTracking = installDirectTauriInvokeTracking();
  cleanupTimerTracking = installTimerTracking();
  cleanupFetchTracking = installFetchTracking();
  if (typeof window !== "undefined") {
    document.addEventListener("click", trackClick, true);
    document.addEventListener("mouseover", trackHover, true);
    document.addEventListener("keydown", trackKeyboard, true);
    document.addEventListener("focus", trackFocus, true);
  }
};

export const disableApiTracking = () => {
  trackingEnabled = false;
  cleanupInterceptors?.();
  cleanupInterceptors = undefined;
  cleanupDirectTauriInvokeTracking?.();
  cleanupDirectTauriInvokeTracking = undefined;
  cleanupTimerTracking?.();
  cleanupTimerTracking = undefined;
  cleanupFetchTracking?.();
  cleanupFetchTracking = undefined;
  cleanupInteractionTracking();
  // Drop in-flight timing/capture state since the result-side counterparts
  // early-return while disabled and would otherwise leak entries forever.
  // apiCalls is intentionally preserved so the recent-log UX still works.
  requestStartTimes.clear();
  pendingCallInfo.clear();
};

export const isApiTrackingEnabled = () => trackingEnabled;

export interface ApiCallHotspot {
  key: string;
  backend: BackendType;
  method: string;
  target: string;
  count: number;
  callsPerMinute: number;
  averageDurationMs?: number;
  lastTimestamp: string;
  firstTimestamp: string;
  interactionType?: InteractionType;
  componentName?: string;
  functionName?: string;
  filePath?: string;
  lineNumber?: number;
  stack?: string;
  isLikelyPolling: boolean;
}

function getCallTarget(call: ApiCall): string {
  return call.backend === "rust" ? call.tauriCommand || call.url : call.fullUrl;
}

function getHotspotKey(call: ApiCall): string {
  const source = call.filePath
    ? `${call.filePath}:${call.lineNumber ?? 0}`
    : call.componentName || call.functionName || "unknown-source";
  return `${call.backend}:${call.method}:${getCallTarget(call)}:${source}`;
}

export const getApiCalls = (): ApiCall[] => {
  return [...apiCalls];
};

export function getApiCallHotspots(windowMs = 120_000): ApiCallHotspot[] {
  const now = Date.now();
  const recentCalls = apiCalls.filter((call) => {
    const timestamp = new Date(call.timestamp).getTime();
    return Number.isFinite(timestamp) && now - timestamp <= windowMs;
  });

  const grouped = new Map<string, ApiCall[]>();
  for (const call of recentCalls) {
    const key = getHotspotKey(call);
    const group = grouped.get(key);
    if (group) group.push(call);
    else grouped.set(key, [call]);
  }

  return Array.from(grouped.entries())
    .map(([key, calls]) => {
      const sortedCalls = [...calls].sort(
        (callA, callB) =>
          new Date(callB.timestamp).getTime() -
          new Date(callA.timestamp).getTime()
      );
      const latestCall = sortedCalls[0];
      const timestamps = calls.map((call) =>
        new Date(call.timestamp).getTime()
      );
      const firstMs = Math.min(...timestamps);
      const lastMs = Math.max(...timestamps);
      const completedDurations = calls
        .map((call) => call.duration)
        .filter((duration): duration is number => typeof duration === "number");
      const averageDurationMs = completedDurations.length
        ? completedDurations.reduce((sum, duration) => sum + duration, 0) /
          completedDurations.length
        : undefined;
      const callsPerMinute = ratePerMinuteInWindow(calls.length, windowMs);

      return {
        key,
        backend: latestCall.backend,
        method: latestCall.method,
        target: getCallTarget(latestCall),
        count: calls.length,
        callsPerMinute,
        averageDurationMs,
        lastTimestamp: latestCall.timestamp,
        firstTimestamp: new Date(firstMs).toISOString(),
        interactionType: latestCall.interactionType,
        componentName: latestCall.componentName,
        functionName: latestCall.functionName,
        filePath: latestCall.filePath,
        lineNumber: latestCall.lineNumber,
        stack: latestCall.stack,
        isLikelyPolling:
          calls.length >= 3 &&
          latestCall.interactionType === "auto" &&
          spansRepeatedActivity(firstMs, lastMs),
      } satisfies ApiCallHotspot;
    })
    .sort((hotspotA, hotspotB) => {
      if (hotspotA.isLikelyPolling !== hotspotB.isLikelyPolling) {
        return hotspotA.isLikelyPolling ? -1 : 1;
      }
      return hotspotB.callsPerMinute - hotspotA.callsPerMinute;
    });
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
      const firesPerMinute = ratePerMinuteInWindow(events.length, windowMs);

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

export const getApiCallsForComponent = (
  componentSelector?: string
): ApiCall[] => {
  if (!componentSelector) return getApiCalls();
  return apiCalls.filter(
    (call) => call.componentSelector === componentSelector
  );
};

export const clearApiCalls = () => {
  apiCalls = [];
  timerEvents.splice(0, timerEvents.length);
  pushEvents.splice(0, pushEvents.length);
  requestStartTimes.clear();

  // Dispatch event for UI update
  window.dispatchEvent(
    new CustomEvent("api-call-updated", {
      detail: { apiCall: null, totalCalls: 0 },
    })
  );
};

export const getRecentApiCalls = (limit: number = 20): ApiCall[] => {
  return apiCalls.slice(0, limit);
};

export const isTracingModeEnabled = () => tracingModeEnabled;

export const toggleTracingMode = (): boolean => {
  tracingModeEnabled = !tracingModeEnabled;

  // Dispatch event for UI notification
  window.dispatchEvent(
    new CustomEvent("api-tracing-mode-changed", {
      detail: { enabled: tracingModeEnabled },
    })
  );
  return tracingModeEnabled;
};

export const enableTracingMode = () => {
  if (!tracingModeEnabled) {
    toggleTracingMode();
  }
};

export const disableTracingMode = () => {
  if (tracingModeEnabled) {
    toggleTracingMode();
  }
};

// ============================================
// Tauri Invoke Tracking
// ============================================

/**
 * Track a Tauri invoke call (Rust backend).
 * Called from the invokeTauri wrapper in tauri/init.ts.
 */
export function trackTauriInvoke(
  cmd: string,
  args: unknown,
  requestId: string
): void {
  if (!trackingEnabled) return;

  const stack = getTauriStack();
  const fileInfo = extractFileInfo(stack);
  const componentInfo = getComponentInfo();

  const apiCall: ApiCall = {
    id: requestId,
    method: "INVOKE",
    url: cmd,
    fullUrl: `tauri://${cmd}`,
    backend: "rust",
    tauriCommand: cmd,
    tauriArgs: args,
    data: args,
    timestamp: new Date().toISOString(),
    componentSelector: componentInfo.selector,
    componentLabel: componentInfo.label,
    interactionType: detectInteractionType(),
    filePath: fileInfo.filePath,
    componentName: fileInfo.componentName,
    functionName: fileInfo.functionName,
    lineNumber: fileInfo.lineNumber,
    stack,
  };

  apiCalls.unshift(apiCall);
  if (apiCalls.length > MAX_API_CALLS) {
    apiCalls = apiCalls.slice(0, MAX_API_CALLS);
  }

  requestStartTimes.set(requestId, Date.now());

  if (tracingModeEnabled) {
    window.dispatchEvent(
      new CustomEvent("api-call-updated", {
        detail: { apiCall, totalCalls: apiCalls.length },
      })
    );
  }
}

/**
 * Record the result of a completed Tauri invoke call.
 */
export function trackTauriInvokeResult(
  requestId: string,
  response: unknown,
  error?: unknown
): void {
  if (!trackingEnabled) return;

  const startTime = requestStartTimes.get(requestId);
  const duration = startTime ? Date.now() - startTime : undefined;
  requestStartTimes.delete(requestId);

  const apiCall = apiCalls.find((call) => call.id === requestId);
  if (!apiCall) return;

  if (error) {
    apiCall.error = error instanceof Error ? error.message : error;
    apiCall.status = 500;
    apiCall.statusText = "Error";
  } else {
    apiCall.response = response;
    apiCall.status = 200;
    apiCall.statusText = "OK";
  }
  apiCall.duration = duration;

  if (tracingModeEnabled) {
    window.dispatchEvent(
      new CustomEvent("api-call-updated", {
        detail: { apiCall, totalCalls: apiCalls.length },
      })
    );
  }
}
