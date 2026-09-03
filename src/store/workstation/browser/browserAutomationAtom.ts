/**
 * Browser Automation State
 *
 * Jotai atoms for tracking the state of the Playwright-based browser
 * automation sidecar (screenshots, status, current URL).
 */
import { atom } from "jotai";

import {
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";
import { registerCache } from "@src/util/memory/cacheRegistry";

// ============================================================================
// Types
// ============================================================================

/** Status of the browser automation sidecar. */
export type BrowserAutomationStatus =
  | "idle"
  | "starting"
  | "running"
  | "paused"
  | "error";

/** State for the browser automation system. */
export interface BrowserAutomationState {
  /** Current status of the automation. */
  status: BrowserAutomationStatus;
  /** URL of the currently active page. */
  currentUrl: string;
  /** Last screenshot (base64-encoded PNG). */
  lastScreenshot: string | null;
  /** Description of the last action performed. */
  lastAction: string | null;
  /** Active tab target ID in the controlled Chrome. */
  targetId: string | null;
  /** Port the sidecar is listening on. */
  port: number | null;
  /** Error message if status is "error". */
  errorMessage: string | null;
  /** Cache of screenshot ID → base64 for resolving [screenshot:ID] markers. */
  screenshotCache: Map<string, string>;
}

/** Event payload from the browser automation sidecar. */
export interface BrowserFrameEvent {
  /** Base64-encoded screenshot. */
  screenshot?: string;
  /** Current page URL. */
  url?: string;
  /** Description of the action that triggered this frame. */
  action?: string;
  /** Active tab target ID. */
  targetId?: string;
  /** Screenshot store ID for resolving [screenshot:ID] markers in chat history. */
  screenshotId?: string;
}

/** Status event from the sidecar. */
export interface BrowserStatusEvent {
  /** New status. */
  status: BrowserAutomationStatus;
  /** Port the sidecar is running on. */
  port?: number;
  /** Error message. */
  error?: string;
}

// ============================================================================
// Atoms
// ============================================================================

const MAX_SCREENSHOT_CACHE = 20;
const MAX_SCREENSHOT_CACHE_BYTES = 24 * 1024 * 1024;

function estimateBase64Bytes(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}

function pruneScreenshotCache(cache: Map<string, string>): Map<string, string> {
  let totalBytes = 0;
  for (const value of cache.values()) {
    totalBytes += estimateBase64Bytes(value);
  }

  while (
    cache.size > MAX_SCREENSHOT_CACHE ||
    totalBytes > MAX_SCREENSHOT_CACHE_BYTES
  ) {
    const firstKey = cache.keys().next().value;
    if (!firstKey) break;
    const value = cache.get(firstKey);
    if (value) totalBytes -= estimateBase64Bytes(value);
    cache.delete(firstKey);
  }

  return cache;
}

const INITIAL_STATE: BrowserAutomationState = {
  status: "idle",
  currentUrl: "",
  lastScreenshot: null,
  lastAction: null,
  targetId: null,
  port: null,
  errorMessage: null,
  screenshotCache: new Map(),
};

/** Primary atom holding browser automation state. */
export const browserAutomationAtom =
  atom<BrowserAutomationState>(INITIAL_STATE);

// -- Write-only dispatch atoms ------------------------------------------------

/** Update state from a browser:frame event (screenshot + action). */
export const browserFrameEventAtom = atom(
  null,
  (get, set, event: BrowserFrameEvent) => {
    const current = get(browserAutomationAtom);

    let cache = current.screenshotCache;
    if (event.screenshotId && event.screenshot) {
      cache = new Map(cache);
      cache.delete(event.screenshotId);
      cache.set(event.screenshotId, event.screenshot);
      cache = pruneScreenshotCache(cache);
    }

    set(browserAutomationAtom, {
      ...current,
      lastScreenshot: event.screenshot ?? current.lastScreenshot,
      currentUrl: event.url ?? current.currentUrl,
      lastAction: event.action ?? current.lastAction,
      targetId: event.targetId ?? current.targetId,
      screenshotCache: cache,
    });
  }
);

/** Update state from a browser:status event. */
export const browserStatusEventAtom = atom(
  null,
  (get, set, event: BrowserStatusEvent) => {
    const current = get(browserAutomationAtom);
    const shouldKeepLiveScreenshot =
      event.status === "running" || event.status === "paused";
    set(browserAutomationAtom, {
      ...current,
      status: event.status,
      port: event.port ?? current.port,
      errorMessage: event.error ?? null,
      lastScreenshot: shouldKeepLiveScreenshot ? current.lastScreenshot : null,
    });
  }
);

/** Reset browser automation state to idle. */
export const resetBrowserAutomationAtom = atom(null, (_get, set) => {
  set(browserAutomationAtom, INITIAL_STATE);
});

/** Read-only atom exposing the screenshot cache for ToolCallBlock resolution. */
export const screenshotCacheAtom = atom(
  (get) => get(browserAutomationAtom).screenshotCache
);

export const screenshotCacheStatsAtom = atom((get) => {
  const state = get(browserAutomationAtom);
  let cacheBytes = 0;
  for (const value of state.screenshotCache.values()) {
    cacheBytes += estimateBase64Bytes(value);
  }
  const liveBytes = state.lastScreenshot
    ? estimateBase64Bytes(state.lastScreenshot)
    : 0;
  return {
    cacheEntries: state.screenshotCache.size,
    cacheBytes,
    liveBytes,
    totalBytes: cacheBytes + liveBytes,
    hasLiveScreenshot: Boolean(state.lastScreenshot),
  };
});

/**
 * Write-only atom: insert a resolved screenshot into the cache.
 * Used after fetching from the Rust ScreenshotStore on cache miss.
 */
export const insertScreenshotCacheAtom = atom(
  null,
  (get, set, entry: { id: string; base64: string }) => {
    const current = get(browserAutomationAtom);
    const cache = new Map(current.screenshotCache);
    cache.delete(entry.id);
    cache.set(entry.id, entry.base64);
    set(browserAutomationAtom, {
      ...current,
      screenshotCache: pruneScreenshotCache(cache),
    });
  }
);

/**
 * Clears cached marker screenshots while preserving the current live frame.
 * Marker screenshots can be refetched from Rust by ID when the replay opens again.
 */
export const clearScreenshotCacheAtom = atom(null, (get, set) => {
  const current = get(browserAutomationAtom);
  if (current.screenshotCache.size === 0) return;
  set(browserAutomationAtom, {
    ...current,
    screenshotCache: new Map(),
  });
});

/** Clears the live browser frame without dropping replay marker screenshots. */
export const clearLiveScreenshotAtom = atom(null, (get, set) => {
  const current = get(browserAutomationAtom);
  if (!current.lastScreenshot) return;
  set(browserAutomationAtom, {
    ...current,
    lastScreenshot: null,
  });
});

registerCache({
  id: "browser.screenshotCache",
  tier: 1,
  estimate: () => {
    if (!isStoreInitialized()) return { bytes: 0, entries: 0 };
    const stats = getInstrumentedStore().get(screenshotCacheStatsAtom);
    return { bytes: stats.totalBytes, entries: stats.cacheEntries };
  },
  trim: () => {
    if (!isStoreInitialized()) return;
    getInstrumentedStore().set(clearScreenshotCacheAtom);
  },
});
