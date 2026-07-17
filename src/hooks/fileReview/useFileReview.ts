/**
 * useFileReview Hook
 *
 * Loads snapshot data for the current session and provides
 * batch undo/keep actions for the consolidated file changes panel.
 *
 * Supports all agent types:
 * - SDE Agent: per-tool-call snapshots (each file edit has its own snapshot)
 * - CLI Session: per-message snapshot (one snapshot for all changes in a run)
 * - OS Agent: per-message snapshot (same as CLI session)
 *
 * Two-phase loading:
 * 1. Session change: full load (snapshots + workspace path) with stale cleanup
 * 2. Event-triggered refresh: lightweight snapshot re-fetch (no cleanup) so
 *    newly created snapshots appear without re-entering the session
 */
import { invoke as invokeTauri } from "@tauri-apps/api/core";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  getFileResolutions,
  getSession,
  getSessionFiles,
  getSnapshots,
  resolveReview,
  restoreSnapshot,
  revertToSnapshot,
} from "@src/api/tauri/agent";
import type { SnapshotRecord } from "@src/api/tauri/agent";
import { beginTimelineBoundary } from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import { sortedEventsAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import { useVisiblePolling } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  clearFileReviewAtom,
  fileReviewResetSignalAtom,
  fileReviewWorkspacePathAtom,
  keepAllFileChangesAtom,
  pendingReviewCountAtom,
  pendingSnapshotAnchorsAtom,
  redoSnapshotAnchorAtom,
  registerFileChangesBatchAtom,
  restoreFileResolutionsAtom,
  undoAllFileChangesAtom,
} from "@src/store/session/fileReviewAtom";
import type { FileResolution } from "@src/store/session/fileReviewAtom";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

const log = createLogger("useFileReview");

const SNAPSHOT_REFRESH_INTERVAL_MS = 1_000;
const SNAPSHOT_REFRESH_WINDOW_MS = 120_000;

// ============================================
// Types
// ============================================

/** Minimal session record for file review (only fields needed for snapshot lookup) */
interface SessionForReview {
  sessionId: string;
  repoPath: string | null;
  [key: string]: unknown;
}

// ============================================
// Helpers
// ============================================

function hasSnapshotSupport(
  sessionId: string | null | undefined
): sessionId is string {
  return !!sessionId;
}

async function fetchSnapshots(sessionId: string): Promise<SnapshotRecord[]> {
  return getSnapshots(sessionId);
}

const PRE_MESSAGE_SNAPSHOT_TOOL_CALL_ID = "__pre_message__";
const CONTROL_SNAPSHOT_TOOL_CALL_PREFIX = "redo:";

export function isReviewableSnapshotRecord(
  record: SnapshotRecord,
  options: { includePreMessageSnapshot: boolean }
): boolean {
  if (record.toolCallId.startsWith(CONTROL_SNAPSHOT_TOOL_CALL_PREFIX)) {
    return false;
  }
  return (
    options.includePreMessageSnapshot ||
    record.toolCallId !== PRE_MESSAGE_SNAPSHOT_TOOL_CALL_ID
  );
}

export function toRegistryEntries(
  records: SnapshotRecord[],
  options: { includePreMessageSnapshot: boolean }
) {
  return records
    .filter((record) => isReviewableSnapshotRecord(record, options))
    .map((record) => ({
      callId: `${record.sessionId}__${record.toolCallId}__${record.createdAt}`,
      snapshotSessionId: record.sessionId,
      snapshotHash: record.hash,
      createdAt: record.createdAt,
    }));
}

async function sessionHasFileChanges(sessionId: string): Promise<boolean> {
  const files = await getSessionFiles(sessionId);
  return files.length > 0;
}

// ============================================
// Hook: Load snapshots for session
// ============================================

/**
 * Loads snapshot records for the active session.
 * Also resolves and stores the workspace path for revert operations.
 * Call this once at the ChatPanel level.
 */
export function useFileReviewSync(
  sessionIdOverride?: string | null,
  enabled = true
): void {
  const globalSessionId = useAtomValue(sessionIdAtom);
  const sessionId =
    sessionIdOverride === undefined ? globalSessionId : sessionIdOverride;
  const events = useAtomValue(sortedEventsAtom);
  const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const resetSignal = useAtomValue(fileReviewResetSignalAtom);
  const registerBatch = useSetAtom(registerFileChangesBatchAtom);
  const clearReview = useSetAtom(clearFileReviewAtom);
  const setWorkspacePath = useSetAtom(fileReviewWorkspacePathAtom);
  const restoreResolutions = useSetAtom(restoreFileResolutionsAtom);

  const loadedSessionRef = useRef<string | null>(null);
  const lastSnapshotCountRef = useRef(0);
  const lastResetSignalRef = useRef(resetSignal);

  // Reset snapshot counter when a batch action (Keep All / Undo All) fires.
  // This allows Phase 2 to pick up new snapshots from the next agent round.
  useEffect(() => {
    if (resetSignal !== lastResetSignalRef.current) {
      lastResetSignalRef.current = resetSignal;
      lastSnapshotCountRef.current = 0;
    }
  }, [resetSignal]);

  // ── Phase 1a: Session change — cleanup + full data load ──
  // Runs only when sessionId changes so workspace-path / snapshot fetches
  // are not repeated on every runtimeStatus transition mid-session.
  useEffect(() => {
    if (!enabled) return;

    if (sessionId !== loadedSessionRef.current) {
      clearReview(sessionId ?? undefined);
      loadedSessionRef.current = sessionId;
      lastSnapshotCountRef.current = 0;
    }

    if (!hasSnapshotSupport(sessionId)) return;

    let cancelled = false;
    const sid = sessionId;

    const loadSnapshots = async (): Promise<number> => {
      try {
        const records = await fetchSnapshots(sid);
        if (cancelled) return 0;

        const hasPreMessageSnapshot = records.some(
          (record) => record.toolCallId === PRE_MESSAGE_SNAPSHOT_TOOL_CALL_ID
        );
        const includePreMessageSnapshot = hasPreMessageSnapshot
          ? await sessionHasFileChanges(sid)
          : false;
        if (cancelled) return 0;

        const entries = toRegistryEntries(records, {
          includePreMessageSnapshot,
        });
        if (entries.length > 0) {
          lastSnapshotCountRef.current = entries.length;
          registerBatch({
            sessionId: sid,
            entries,
          });
        } else {
          clearReview(sid);
          lastSnapshotCountRef.current = 0;
        }
        return entries.length;
      } catch (error) {
        if (!cancelled) {
          log.error("[useFileReviewSync] Failed to load snapshots:", error);
        }
        return 0;
      }
    };

    const loadWorkspacePath = async () => {
      try {
        if (isCliSession(sid)) {
          const session = await invokeTauri<SessionForReview | null>(
            "cli_agent_status",
            { sessionId: sid }
          );
          if (!cancelled && session?.repoPath) {
            setWorkspacePath(session.repoPath);
          }
        } else if (isAgentSession(sid)) {
          const session = await getSession(sid);
          if (!cancelled && session?.workspacePath) {
            setWorkspacePath(session.workspacePath);
          }
        }
      } catch (error) {
        if (!cancelled) {
          log.error(
            "[useFileReviewSync] Failed to load workspace path:",
            error
          );
        }
      }
    };

    const loadFileResolutions = async () => {
      try {
        const records = await getFileResolutions(sid);
        if (cancelled || records.length === 0) return;
        restoreResolutions(
          records.map((record) => ({
            path: record.path,
            resolution: record.resolution as FileResolution,
          }))
        );
      } catch (error) {
        if (!cancelled) {
          log.warn(
            "[useFileReviewSync] Failed to load file resolutions:",
            error
          );
        }
      }
    };

    void Promise.all([
      loadSnapshots(),
      loadWorkspacePath(),
      loadFileResolutions(),
    ]);

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    registerBatch,
    clearReview,
    setWorkspacePath,
    restoreResolutions,
    enabled,
  ]);

  // ── Phase 1b: Stale-snapshot verification — runs when session finishes ──
  // Once the agent completes/fails, check whether the backend still has
  // pending file changes. If not, clear the stale review state so the
  // "Undo All / Keep All" pill disappears automatically.
  // Separated from Phase 1a so workspace-path and snapshot fetches are not
  // re-triggered on every runtimeStatus change (idle→running→completed).
  useEffect(() => {
    if (!enabled || !hasSnapshotSupport(sessionId)) return;

    const sessionFinished = [
      "completed",
      "failed",
      "error",
      "cancelled",
    ].includes(runtimeStatus);
    if (!sessionFinished) return;

    let cancelled = false;
    const sid = sessionId;

    const verifyFinishedState = async () => {
      try {
        const records = await fetchSnapshots(sid);
        if (cancelled) return;

        const hasPreMessageSnapshot = records.some(
          (record) => record.toolCallId === PRE_MESSAGE_SNAPSHOT_TOOL_CALL_ID
        );
        const includePreMessageSnapshot = hasPreMessageSnapshot
          ? await sessionHasFileChanges(sid)
          : false;
        if (cancelled) return;

        const entries = toRegistryEntries(records, {
          includePreMessageSnapshot,
        });
        if (entries.length > 0) {
          lastSnapshotCountRef.current = Math.max(
            lastSnapshotCountRef.current,
            entries.length
          );
          registerBatch({
            sessionId: sid,
            entries,
          });
          return;
        }

        const hasFileChanges = await sessionHasFileChanges(sid);
        if (cancelled || hasFileChanges) return;
        clearReview(sid);
        lastSnapshotCountRef.current = 0;
      } catch (error) {
        if (!cancelled) {
          log.warn("[useFileReviewSync] Failed to verify file changes:", error);
        }
      }
    };

    void verifyFinishedState();

    return () => {
      cancelled = true;
    };
  }, [sessionId, runtimeStatus, clearReview, registerBatch, enabled]);

  const snapshotRefreshStartedAtRef = useRef(0);
  useEffect(() => {
    snapshotRefreshStartedAtRef.current = Date.now();
  }, [events.length, sessionId]);

  const refreshSnapshots = useCallback(
    async (signal?: AbortSignal) => {
      if (!enabled || !hasSnapshotSupport(sessionId)) return false;
      if (
        Date.now() - snapshotRefreshStartedAtRef.current >
        SNAPSHOT_REFRESH_WINDOW_MS
      ) {
        return false;
      }

      try {
        const records = await fetchSnapshots(sessionId);
        if (signal?.aborted) return false;
        if (records.length === 0) return true;
        const hasPreMessageSnapshot = records.some(
          (record) => record.toolCallId === PRE_MESSAGE_SNAPSHOT_TOOL_CALL_ID
        );
        const includePreMessageSnapshot = hasPreMessageSnapshot
          ? await sessionHasFileChanges(sessionId)
          : false;
        if (signal?.aborted) return false;
        const entries = toRegistryEntries(records, {
          includePreMessageSnapshot,
        });
        if (entries.length === 0) return true;
        lastSnapshotCountRef.current = Math.max(
          lastSnapshotCountRef.current,
          entries.length
        );
        registerBatch({ sessionId, entries });
      } catch (error) {
        log.warn("[useFileReviewSync] Snapshot refresh failed:", error);
      }
      return true;
    },
    [enabled, registerBatch, sessionId]
  );

  useVisiblePolling({
    enabled: enabled && hasSnapshotSupport(sessionId),
    intervalMs: SNAPSHOT_REFRESH_INTERVAL_MS,
    poll: refreshSnapshots,
    restartKey: events.length,
  });
}

// ============================================
// Hook: Batch review actions (for summary panel)
// ============================================

interface UseFileReviewBatchActionsResult {
  pendingCount: number;
  redoSnapshotAnchors: Array<{
    sessionId: string;
    snapshotId: string;
    createdAt: string;
  }>;
  onUndoAll: () => Promise<void>;
  onKeepAll: () => Promise<void>;
  onRedo: () => Promise<void>;
}

/**
 * Provides batch actions for the consolidated file changes panel.
 * - onUndoAll: reverts to the earliest pending snapshot, then marks all as undone
 * - onKeepAll: marks all pending entries as kept
 * - onRedo: re-applies the most recent rewind using the stored redo snapshot
 */
export function useFileReviewBatchActions(
  sessionIdOverride?: string | null
): UseFileReviewBatchActionsResult {
  const globalSessionId = useAtomValue(sessionIdAtom);
  const sessionId = sessionIdOverride ?? globalSessionId;
  const pendingCount = useAtomValue(pendingReviewCountAtom);
  const pendingSnapshotAnchors = useAtomValue(pendingSnapshotAnchorsAtom);
  const redoSnapshotAnchors = useAtomValue(redoSnapshotAnchorAtom);
  const setRedoSnapshotAnchors = useSetAtom(redoSnapshotAnchorAtom);
  const dispatchUndoAll = useSetAtom(undoAllFileChangesAtom);
  const dispatchKeepAll = useSetAtom(keepAllFileChangesAtom);

  const onUndoAll = useCallback(async () => {
    if (pendingSnapshotAnchors.length === 0 || !sessionId) return;

    beginTimelineBoundary(sessionId, "rewind");

    const earliestBySession = new Map<string, string>();
    for (const anchor of pendingSnapshotAnchors) {
      const currentEarliest = earliestBySession.get(anchor.sessionId);
      if (!currentEarliest || anchor.createdAt < currentEarliest) {
        earliestBySession.set(anchor.sessionId, anchor.createdAt);
      }
    }

    try {
      const results = await Promise.all(
        Array.from(earliestBySession.entries()).map(
          ([ownerSessionId, createdAt]) =>
            revertToSnapshot(ownerSessionId, createdAt)
        )
      );
      const changedFileCount = results.reduce(
        (total, result) => total + result.restored + result.deleted,
        0
      );
      if (changedFileCount === 0) {
        throw new Error(
          `Undo All completed without restoring or deleting files: ${JSON.stringify(results)}`
        );
      }
      const redoAnchors = results.flatMap((result) => result.redoAnchors ?? []);
      const reviewSessionIds = new Set([
        sessionId,
        ...pendingSnapshotAnchors.map((anchor) => anchor.sessionId),
      ]);
      await Promise.all(
        Array.from(reviewSessionIds).map((reviewSessionId) =>
          resolveReview(reviewSessionId)
        )
      );
      dispatchUndoAll();
      setRedoSnapshotAnchors(redoAnchors);
    } catch (error) {
      log.error("[useFileReviewBatchActions] Revert all failed:", error);
      throw error;
    }
  }, [
    pendingSnapshotAnchors,
    sessionId,
    dispatchUndoAll,
    setRedoSnapshotAnchors,
  ]);

  const onKeepAll = useCallback(async () => {
    if (sessionId) {
      await resolveReview(sessionId);
    }
    dispatchKeepAll();
  }, [sessionId, dispatchKeepAll]);

  const onRedo = useCallback(async () => {
    if (redoSnapshotAnchors.length === 0 || !sessionId) return;

    try {
      const results = await Promise.all(
        redoSnapshotAnchors.map((anchor) =>
          restoreSnapshot(anchor.sessionId, anchor.snapshotId)
        )
      );
      const changedFileCount = results.reduce(
        (total, result) => total + result.restored + result.deleted,
        0
      );
      if (changedFileCount === 0) {
        throw new Error(
          `Redo completed without restoring or deleting files: ${JSON.stringify(results)}`
        );
      }
      await resolveReview(sessionId);
      dispatchUndoAll();
      setRedoSnapshotAnchors([]);
    } catch (error) {
      log.error("[useFileReviewBatchActions] Redo failed:", error);
      throw error;
    }
  }, [redoSnapshotAnchors, sessionId, dispatchUndoAll, setRedoSnapshotAnchors]);

  return { pendingCount, redoSnapshotAnchors, onUndoAll, onKeepAll, onRedo };
}
