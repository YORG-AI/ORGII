/**
 * Cross-window focus aggregation for app-wide foreground leases.
 *
 * With detached session windows, "the app is in the foreground" is no longer
 * the same statement as "THIS window is focused": a user working in a
 * detached window keeps the MAIN window blurred, and any main-window-only
 * service keyed on own-window focus (the realtime connection lease) would
 * wrongly wind down after its blur grace. Every window publishes its focus
 * state over `BroadcastChannel("orgii:window-focus")` — with a localStorage
 * heartbeat map as the fallback transport — and `isAnyAppWindowFocused()`
 * answers the app-wide question: this window focused, or any peer window
 * whose focused claim is fresh within `CROSS_WINDOW_FOCUS_TTL_MS`.
 *
 * A focused window re-publishes on a short heartbeat so its claim never goes
 * stale; a closed or crashed window simply stops publishing and drops out of
 * the aggregate within the TTL. Outside Tauri (browser dev, unit tests)
 * there is only one document, so the aggregate collapses to plain own-window
 * focus and the publisher is a no-op — existing single-window behavior and
 * tests are unchanged.
 */
import { isWindowFocused } from "@src/util/core/windowFocus";
import { getCurrentWindowLabel } from "@src/util/platform/tauri/windowIdentity";

export const CROSS_WINDOW_FOCUS_CHANNEL_NAME = "orgii:window-focus";
export const CROSS_WINDOW_FOCUS_STORAGE_KEY = "orgii:window-focus:v1";

/** A peer's focused=true claim is trusted for this long after its `at`. */
export const CROSS_WINDOW_FOCUS_TTL_MS = 15_000;

/** Focused windows re-publish on this cadence so their claim stays fresh. */
export const CROSS_WINDOW_FOCUS_HEARTBEAT_MS = 5_000;

/** Entries idle this long are garbage-collected from the storage map. */
const STORAGE_ENTRY_GC_MS = 10 * CROSS_WINDOW_FOCUS_TTL_MS;

export interface CrossWindowFocusEntry {
  readonly focused: boolean;
  /** Publish timestamp, `Date.now()` milliseconds. */
  readonly at: number;
}

/**
 * Pure aggregation core: own focus always wins; otherwise any peer whose
 * focused claim is no older than `ttlMs` counts. Unfocused or stale claims
 * never do — staleness is how a dead window leaves the aggregate.
 */
export function aggregateCrossWindowFocus(
  ownFocused: boolean,
  peers: Iterable<CrossWindowFocusEntry>,
  nowMs: number,
  ttlMs: number = CROSS_WINDOW_FOCUS_TTL_MS
): boolean {
  if (ownFocused) return true;
  for (const peer of peers) {
    if (peer.focused && nowMs - peer.at <= ttlMs) return true;
  }
  return false;
}

/** Parse the persisted heartbeat map; malformed input degrades to empty. */
export function parseCrossWindowFocusMap(
  raw: string | null
): Record<string, CrossWindowFocusEntry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const map: Record<string, CrossWindowFocusEntry> = {};
    for (const [label, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null) continue;
      const { focused, at } = value as { focused?: unknown; at?: unknown };
      if (typeof focused !== "boolean") continue;
      if (typeof at !== "number" || !Number.isFinite(at)) continue;
      map[label] = { focused, at };
    }
    return map;
  } catch {
    return {};
  }
}

/** Peer focus claims received over the BroadcastChannel transport. */
const peerFocusByLabel = new Map<string, CrossWindowFocusEntry>();
const focusChangeListeners = new Set<() => void>();

interface CrossWindowFocusRuntime {
  refCount: number;
  stop: () => void;
}

let runtime: CrossWindowFocusRuntime | null = null;

function notifyFocusChangeListeners(): void {
  for (const listener of [...focusChangeListeners]) listener();
}

function recordPeerMessage(ownLabel: string, data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  const { label, focused, at } = data as {
    label?: unknown;
    focused?: unknown;
    at?: unknown;
  };
  if (typeof label !== "string" || label === ownLabel) return;
  if (typeof focused !== "boolean") return;
  if (typeof at !== "number" || !Number.isFinite(at)) return;
  peerFocusByLabel.set(label, { focused, at });
  notifyFocusChangeListeners();
}

function readStoredFocusMap(): Record<string, CrossWindowFocusEntry> {
  try {
    if (typeof localStorage === "undefined") return {};
    return parseCrossWindowFocusMap(
      localStorage.getItem(CROSS_WINDOW_FOCUS_STORAGE_KEY)
    );
  } catch {
    return {};
  }
}

function writeOwnFocusHeartbeat(
  ownLabel: string,
  entry: CrossWindowFocusEntry
): void {
  try {
    if (typeof localStorage === "undefined") return;
    const next: Record<string, CrossWindowFocusEntry> = {};
    for (const [label, existing] of Object.entries(readStoredFocusMap())) {
      if (entry.at - existing.at <= STORAGE_ENTRY_GC_MS) next[label] = existing;
    }
    next[ownLabel] = entry;
    localStorage.setItem(CROSS_WINDOW_FOCUS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode, quota): the BroadcastChannel
    // transport or plain staleness covers it.
  }
}

/**
 * App-wide foreground truth: this window focused, or any peer window with a
 * fresh focused claim. Outside Tauri there are no peer windows, so this is
 * exactly own-window focus (existing lease behavior and tests unchanged).
 */
export function isAnyAppWindowFocused(): boolean {
  const ownFocused = isWindowFocused();
  const ownLabel = getCurrentWindowLabel();
  if (ownLabel === null || ownFocused) return ownFocused;
  const now = Date.now();
  if (aggregateCrossWindowFocus(false, peerFocusByLabel.values(), now)) {
    return true;
  }
  // Storage fallback: peers without BroadcastChannel, and peers that
  // published before this window's channel existed.
  const storedPeers = Object.entries(readStoredFocusMap())
    .filter(([label]) => label !== ownLabel)
    .map(([, entry]) => entry);
  return aggregateCrossWindowFocus(false, storedPeers, now);
}

/**
 * Notify on peer focus publications (a BroadcastChannel message or a
 * cross-window storage write). Own-window focus events are deliberately not
 * re-broadcast here — callers already listen to those directly.
 */
export function subscribeCrossWindowFocus(listener: () => void): () => void {
  focusChangeListeners.add(listener);
  return () => {
    focusChangeListeners.delete(listener);
  };
}

/**
 * Publish this window's focus state to its peers on focus/blur/visibility
 * flips plus a heartbeat while focused. Idempotent per window: one shared
 * transport regardless of caller count; the returned stop handle releases
 * this caller's interest and tears the transport down with the last one.
 * No-op outside Tauri.
 */
export function startCrossWindowFocusPublisher(): () => void {
  const ownLabel = getCurrentWindowLabel();
  if (
    ownLabel === null ||
    typeof window === "undefined" ||
    typeof document === "undefined"
  ) {
    return () => {};
  }
  if (!runtime) {
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      try {
        channel = new BroadcastChannel(CROSS_WINDOW_FOCUS_CHANNEL_NAME);
        channel.onmessage = (event) => recordPeerMessage(ownLabel, event.data);
      } catch {
        channel = null;
      }
    }
    const publish = (focused: boolean) => {
      const entry: CrossWindowFocusEntry = { focused, at: Date.now() };
      try {
        channel?.postMessage({ label: ownLabel, ...entry });
      } catch {
        // A closed/errored channel degrades to the storage heartbeat.
      }
      writeOwnFocusHeartbeat(ownLabel, entry);
    };
    const publishCurrent = () => publish(isWindowFocused());
    // The window is going away; do not leave a focused claim that only the
    // TTL can expire.
    const handlePageHide = () => publish(false);
    // Peer publications without BroadcastChannel arrive as cross-window
    // storage events (fired only in OTHER windows, so no self-loop).
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== CROSS_WINDOW_FOCUS_STORAGE_KEY) {
        return;
      }
      notifyFocusChangeListeners();
    };
    const heartbeat = setInterval(() => {
      if (isWindowFocused()) publish(true);
    }, CROSS_WINDOW_FOCUS_HEARTBEAT_MS);
    window.addEventListener("focus", publishCurrent);
    window.addEventListener("blur", publishCurrent);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("storage", handleStorage);
    document.addEventListener("visibilitychange", publishCurrent);
    publishCurrent();
    runtime = {
      refCount: 0,
      stop: () => {
        clearInterval(heartbeat);
        window.removeEventListener("focus", publishCurrent);
        window.removeEventListener("blur", publishCurrent);
        window.removeEventListener("pagehide", handlePageHide);
        window.removeEventListener("storage", handleStorage);
        document.removeEventListener("visibilitychange", publishCurrent);
        publish(false);
        channel?.close();
      },
    };
  }
  const active = runtime;
  active.refCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.refCount -= 1;
    if (active.refCount <= 0 && runtime === active) {
      runtime = null;
      active.stop();
    }
  };
}

/** Test hook: drop the transport, peer claims, and listeners. */
export function resetCrossWindowFocusForTests(): void {
  if (runtime) {
    const active = runtime;
    runtime = null;
    active.stop();
  }
  peerFocusByLabel.clear();
  focusChangeListeners.clear();
}
