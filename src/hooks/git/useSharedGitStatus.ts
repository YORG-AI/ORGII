/**
 * Shared git status store.
 *
 * Every Source Control surface used to own its own `repo:status_updated`
 * subscription and its own `GET /status` request. One watcher event therefore
 * fanned out into N identical HTTP calls — the in-flight dedup in
 * `api/http/git/client` evicts after 100ms, while the consumers debounce at
 * 300/500/800ms, so their requests never landed in the same window.
 *
 * This module owns one subscription and one in-flight request per
 * repo id + path; React consumers read the shared snapshot through
 * `useSyncExternalStore`. Mirrors `useWorkingTreeDiffTotals`, which already
 * solved this for the numstat endpoint.
 */
import { useCallback, useSyncExternalStore } from "react";

import { getGitStatus } from "@src/api/http/git/status";
import type { GitStatusData } from "@src/api/http/git/types";
import { getCodeEditorWebSocket } from "@src/api/realtime/codeEditorWebSocket";
import { decodeOctalPath } from "@src/util/file/pathUtils";

export interface SharedGitStatusSnapshot {
  /** Null until the first response lands for this repo key. */
  status: GitStatusData | null;
  /** True only before the first settled response — never on background refresh. */
  initialLoading: boolean;
  error: string | null;
}

const EMPTY_SNAPSHOT: SharedGitStatusSnapshot = {
  status: null,
  initialLoading: true,
  error: null,
};

const REFRESH_DEBOUNCE_MS = 300;

interface StatusEntry {
  key: string;
  repoId: string;
  repoPath: string;
  snapshot: SharedGitStatusSnapshot;
  subscribers: Set<() => void>;
  unsubscribeStatus?: () => void;
  debounceTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  refreshAfterInFlight: boolean;
  refreshOnVisible: boolean;
  visibilityHandler?: () => void;
}

const entriesByKey = new Map<string, StatusEntry>();

function repoKeyOf(repoId: string, repoPath: string): string {
  return `${repoId}\u0000${repoPath}`;
}

function notify(entry: StatusEntry): void {
  for (const subscriber of entry.subscribers) subscriber();
}

/**
 * Git reports non-ASCII paths in octal escapes. Decoding here means every
 * consumer sees the same display-ready paths rather than each repeating it.
 */
function decodeStatus(status: GitStatusData): GitStatusData {
  return {
    ...status,
    working_directory: {
      ...status.working_directory,
      files: status.working_directory.files.map((file) => ({
        ...file,
        path: decodeOctalPath(file.path),
        original_path: file.original_path
          ? decodeOctalPath(file.original_path)
          : null,
      })),
    },
  };
}

function getOrCreateEntry(repoId: string, repoPath: string): StatusEntry {
  const key = repoKeyOf(repoId, repoPath);
  const existing = entriesByKey.get(key);
  if (existing) return existing;

  const entry: StatusEntry = {
    key,
    repoId,
    repoPath,
    snapshot: EMPTY_SNAPSHOT,
    subscribers: new Set(),
    refreshAfterInFlight: false,
    refreshOnVisible: false,
  };
  entriesByKey.set(key, entry);
  return entry;
}

function refreshEntry(entry: StatusEntry): Promise<void> {
  if (entry.inFlight) {
    entry.refreshAfterInFlight = true;
    return entry.inFlight;
  }

  entry.inFlight = getGitStatus({
    repo_id: entry.repoId,
    repo_path: entry.repoPath,
  })
    .then((status) => {
      if (!status) {
        entry.snapshot = {
          status: entry.snapshot.status,
          initialLoading: false,
          error: "Failed to fetch git status",
        };
        notify(entry);
        return;
      }
      entry.snapshot = {
        status: decodeStatus(status),
        initialLoading: false,
        error: null,
      };
      notify(entry);
    })
    .catch((err: unknown) => {
      entry.snapshot = {
        // Keep the last good status so the file list does not blank on a
        // transient failure.
        status: entry.snapshot.status,
        initialLoading: false,
        error: err instanceof Error ? err.message : String(err),
      };
      notify(entry);
    })
    .finally(() => {
      entry.inFlight = undefined;
      if (entry.refreshAfterInFlight && entry.subscribers.size > 0) {
        entry.refreshAfterInFlight = false;
        void refreshEntry(entry);
      }
    });

  return entry.inFlight;
}

function scheduleRefresh(entry: StatusEntry): void {
  if (entry.debounceTimer) return;
  entry.debounceTimer = setTimeout(() => {
    entry.debounceTimer = undefined;
    void refreshEntry(entry);
  }, REFRESH_DEBOUNCE_MS);
}

function startEntry(entry: StatusEntry): void {
  if (!entry.unsubscribeStatus) {
    const websocket = getCodeEditorWebSocket();
    if (websocket) {
      entry.unsubscribeStatus = websocket.on("repo:status_updated", (data) => {
        const payload = data as { repo_id?: string };
        if (payload.repo_id !== entry.repoId) return;
        if (typeof document !== "undefined" && document.hidden) {
          entry.refreshOnVisible = true;
          return;
        }
        scheduleRefresh(entry);
      });
    }
  }
  if (typeof document !== "undefined" && !entry.visibilityHandler) {
    entry.visibilityHandler = () => {
      if (document.hidden || !entry.refreshOnVisible) return;
      entry.refreshOnVisible = false;
      scheduleRefresh(entry);
    };
    document.addEventListener("visibilitychange", entry.visibilityHandler);
  }
  void refreshEntry(entry);
}

function stopEntry(entry: StatusEntry): void {
  entry.unsubscribeStatus?.();
  entry.unsubscribeStatus = undefined;
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = undefined;
  }
  if (typeof document !== "undefined" && entry.visibilityHandler) {
    document.removeEventListener("visibilitychange", entry.visibilityHandler);
    entry.visibilityHandler = undefined;
  }
  entry.refreshOnVisible = false;
}

export function subscribeSharedGitStatus(
  repoId: string,
  repoPath: string,
  callback: () => void
): () => void {
  const entry = getOrCreateEntry(repoId, repoPath);
  entry.subscribers.add(callback);
  if (entry.subscribers.size === 1) startEntry(entry);

  return () => {
    entry.subscribers.delete(callback);
    if (entry.subscribers.size !== 0) return;
    stopEntry(entry);
    // React Strict Mode briefly unsubscribes and re-subscribes during one
    // commit. Defer deletion so that cycle retains the same shared entry.
    queueMicrotask(() => {
      if (
        entry.subscribers.size === 0 &&
        entriesByKey.get(entry.key) === entry
      ) {
        entriesByKey.delete(entry.key);
      }
    });
  };
}

export function getSharedGitStatusSnapshot(
  repoId: string,
  repoPath: string
): SharedGitStatusSnapshot {
  return (
    entriesByKey.get(repoKeyOf(repoId, repoPath))?.snapshot ?? EMPTY_SNAPSHOT
  );
}

/**
 * Forces an immediate refresh, bypassing the WebSocket debounce. Call after a
 * local mutation (stage, commit, discard) where the caller needs the updated
 * status before continuing. Resolves once the resulting request settles.
 */
export function refreshSharedGitStatus(
  repoId: string,
  repoPath: string
): Promise<void> {
  const entry = getOrCreateEntry(repoId, repoPath);
  if (entry.debounceTimer) {
    clearTimeout(entry.debounceTimer);
    entry.debounceTimer = undefined;
  }
  if (!entry.inFlight) return refreshEntry(entry);

  // A request is already open and may predate this mutation, so its response
  // could be stale. Wait it out, then issue a fresh one.
  return entry.inFlight.then(() => refreshEntry(entry));
}

/**
 * Returns one shared git status snapshot for a repository. Consumers with the
 * same repo id/path share one WebSocket subscription and one request.
 */
export function useSharedGitStatus(
  repoId: string | undefined,
  repoPath: string | undefined
): SharedGitStatusSnapshot {
  const active = Boolean(repoId && repoPath);
  const subscribe = useCallback(
    (callback: () => void) => {
      if (!active || !repoId || !repoPath) return () => {};
      return subscribeSharedGitStatus(repoId, repoPath, callback);
    },
    [active, repoId, repoPath]
  );
  const getSnapshot = useCallback(() => {
    if (!active || !repoId || !repoPath) return EMPTY_SNAPSHOT;
    return getSharedGitStatusSnapshot(repoId, repoPath);
  }, [active, repoId, repoPath]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
