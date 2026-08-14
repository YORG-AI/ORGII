/**
 * Live download progress for cloud session replays.
 *
 * The paged events RPC reports the session's total event count on every
 * page, and the streaming importer already tracks how many events it has
 * persisted — this atom is where those numbers become visible to the UI
 * (sidebar row percent, Chat Pane progress bar) instead of being discarded.
 *
 * Keyed by the LOCAL imported-session id: the Chat Pane tab that opens
 * synchronously with the replay is keyed by it, and the sidebar reaches it
 * through the busy entry's `localSessionId`.
 */
import { atom, type createStore } from "jotai";

import { formatDurationCompact } from "@src/util/time/formatDuration";

import type { CloudSessionEnvironmentIdentity } from "./cloudSessionDownloadControlAtoms";

export interface CloudSessionDownloadProgress {
  /** Remote row id (`RemoteTeammateSessionMetadata.id`) this download serves. */
  rowId: string;
  orgId: string;
  /** Immutable remote labels copied from the source row for pre-import UI. */
  sessionEnvironment?: CloudSessionEnvironmentIdentity;
  loadedEvents: number;
  /** Server-reported total events for the session; null until known. */
  totalEvents: number | null;
  /**
   * Events that were already durable before this transfer started (resume
   * position / incremental covered base). Excluded from the ETA rate so a
   * resumed bar does not fake an instant finish.
   */
  baseEvents?: number;
  startedAtMs: number;
  updatedAtMs: number;
  phase: "downloading" | "finalizing" | "paused" | "completed";
}

export const cloudSessionDownloadProgressAtom = atom<
  ReadonlyMap<string, CloudSessionDownloadProgress>
>(new Map());
cloudSessionDownloadProgressAtom.debugLabel = "org2cloud/downloadProgress";

export const upsertCloudSessionDownloadProgressAtom = atom(
  null,
  (
    get,
    set,
    payload: { localSessionId: string; progress: CloudSessionDownloadProgress }
  ) => {
    const next = new Map(get(cloudSessionDownloadProgressAtom));
    next.set(payload.localSessionId, payload.progress);
    set(cloudSessionDownloadProgressAtom, next);
  }
);
upsertCloudSessionDownloadProgressAtom.debugLabel =
  "org2cloud/upsertDownloadProgress";

export const clearCloudSessionDownloadProgressAtom = atom(
  null,
  (get, set, localSessionId: string) => {
    const current = get(cloudSessionDownloadProgressAtom);
    if (!current.has(localSessionId)) return;
    const next = new Map(current);
    next.delete(localSessionId);
    set(cloudSessionDownloadProgressAtom, next);
  }
);
clearCloudSessionDownloadProgressAtom.debugLabel =
  "org2cloud/clearDownloadProgress";

/**
 * Percent complete, clamped to [0, 99] while the download is still running —
 * 100 only ever comes from the completed linger state.
 */
export function cloudDownloadPercent(
  progress: CloudSessionDownloadProgress
): number | null {
  if (progress.phase === "completed") return 100;
  if (progress.totalEvents === null || progress.totalEvents <= 0) return null;
  const raw = Math.floor((progress.loadedEvents / progress.totalEvents) * 100);
  return Math.min(99, Math.max(0, raw));
}

/**
 * Remaining time estimated from the overall average page rate. Null until
 * enough has been observed to be meaningful.
 */
export function cloudDownloadEtaMs(
  progress: CloudSessionDownloadProgress
): number | null {
  if (progress.totalEvents === null || progress.loadedEvents <= 0) return null;
  const elapsedMs = progress.updatedAtMs - progress.startedAtMs;
  if (elapsedMs < 500) return null;
  // Rate from what THIS transfer moved: a resumed/incremental bar starts at
  // its durable base, which took no time in this run.
  const transferred = progress.loadedEvents - (progress.baseEvents ?? 0);
  if (transferred <= 0) return null;
  const eventsPerMs = transferred / elapsedMs;
  const remaining = Math.max(0, progress.totalEvents - progress.loadedEvents);
  return Math.round(remaining / eventsPerMs);
}

export interface CloudDownloadProgressUpsert {
  localSessionId: string;
  progress: CloudSessionDownloadProgress;
}

type JotaiStore = ReturnType<typeof createStore>;

/**
 * A fast transfer used to flash: the card appeared, jumped, and vanished in
 * well under a second — indistinguishable from a glitch. Successful
 * downloads therefore hold a terminal "completed · 100%" card until the
 * surface has been visible for at least this long (measured from the first
 * progress tick). Slow transfers already showed continuous feedback and
 * clear immediately. The transcript is NEVER delayed — the card lingers
 * pinned above it.
 */
export const CLOUD_DOWNLOAD_MIN_VISIBLE_MS = 3_000;

/**
 * Flip a live progress entry to its terminal completed state and clear it
 * once the minimum visible window has elapsed. The deferred clear is
 * identity-guarded: a new download for the same session replaces the entry
 * and must not be reaped by the old timer. No-op without a live entry.
 */
export function completeCloudDownloadProgressWithLinger(
  store: JotaiStore,
  localSessionId: string,
  minVisibleMs: number = CLOUD_DOWNLOAD_MIN_VISIBLE_MS
): void {
  const current = store
    .get(cloudSessionDownloadProgressAtom)
    .get(localSessionId);
  if (!current || current.phase === "paused") return;
  const now = Date.now();
  const completed: CloudSessionDownloadProgress = {
    ...current,
    loadedEvents: current.totalEvents ?? current.loadedEvents,
    updatedAtMs: now,
    phase: "completed",
  };
  const lingerMs = Math.max(0, minVisibleMs - (now - current.startedAtMs));
  if (lingerMs === 0) {
    store.set(clearCloudSessionDownloadProgressAtom, localSessionId);
    return;
  }
  store.set(upsertCloudSessionDownloadProgressAtom, {
    localSessionId,
    progress: completed,
  });
  setTimeout(() => {
    if (
      store.get(cloudSessionDownloadProgressAtom).get(localSessionId) ===
      completed
    ) {
      store.set(clearCloudSessionDownloadProgressAtom, localSessionId);
    }
  }, lingerMs);
}

/**
 * Trailing-edge throttle for progress writes. Every segment decode lands in
 * its own microtask, so unthrottled writes re-render every subscriber (both
 * sidebar connectors, the chat pane) at network speed for zero visual gain —
 * the bar already animates `transition-[width] duration-300`. Non-downloading
 * phases (finalizing/paused) flush immediately: state changes must never sit
 * in the trailing slot. Call `cancel()` before writing a terminal state
 * directly, or a parked tick can resurrect a cleared entry.
 */
export function createThrottledProgressReporter(
  write: (payload: CloudDownloadProgressUpsert) => void,
  intervalMs = 150
): {
  report: (payload: CloudDownloadProgressUpsert) => void;
  cancel: () => void;
} {
  let lastWriteAtMs = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let pending: CloudDownloadProgressUpsert | null = null;
  const flushPending = (): void => {
    trailing = null;
    if (!pending) return;
    const payload = pending;
    pending = null;
    lastWriteAtMs = Date.now();
    write(payload);
  };
  return {
    report(payload) {
      const now = Date.now();
      if (
        payload.progress.phase !== "downloading" ||
        now - lastWriteAtMs >= intervalMs
      ) {
        if (trailing) clearTimeout(trailing);
        trailing = null;
        pending = null;
        lastWriteAtMs = now;
        write(payload);
        return;
      }
      pending = payload;
      trailing ??= setTimeout(flushPending, intervalMs - (now - lastWriteAtMs));
    },
    cancel() {
      if (trailing) clearTimeout(trailing);
      trailing = null;
      pending = null;
    },
  };
}

/** Compact locale-neutral duration: "8s", "1m20s", "2h05m". */
export function formatCloudDownloadEta(etaMs: number): string {
  return formatDurationCompact(etaMs);
}
