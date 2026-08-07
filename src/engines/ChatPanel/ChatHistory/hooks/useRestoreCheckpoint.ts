/**
 * useRestoreCheckpoint Hook
 *
 * Restores the session to a previous checkpoint WITHOUT re-sending a message
 * (Cursor-style "restore to checkpoint"). This is the same destructive
 * truncate path as `useEditUserMessage`, MINUS the final re-dispatch:
 *
 * 1. Checks whether file changes exist after the target message
 * 2. If so, shows a three-choice dialog (revert / keep / cancel)
 * 3. Sets a truncation guard to prevent sync effects from re-adding events
 * 4. Truncates the event and everything after it from SQLite
 * 5. Splices the event and all subsequent events from the live Rust store
 * 6. Optionally reverts files
 * 7. Leaves the turn at idle — the session sits at the checkpoint, no resend
 *
 * Message-side restore is destructive (no message-side redo); the file-side
 * snapshot store keeps its own redo path via Undo All / Redo All.
 */
import { useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  checkSnapshotChanges,
  truncateAfterMessage,
} from "@src/api/tauri/agent";
import { deleteOrgtrackSessionArtifacts } from "@src/api/tauri/lineage";
import Message from "@src/components/Message";
import { editTruncationTimestampAtom } from "@src/engines/SessionCore";
import { cancelTurnForTimelineBoundary } from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { truncateAfterEvent as truncateCacheAfterEvent } from "@src/engines/SessionCore/storage/sqliteCache";
import { createLogger } from "@src/hooks/logger";
import {
  clearPendingPlanApproval,
  pendingPlanApprovalsAtom,
} from "@src/store/session/planApprovalAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { clearTodosForSessionAtom } from "@src/store/ui/todoAtom";
import { invokeTauri } from "@src/util/platform/tauri/init";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

import type { OptimizedChatItem } from "../chatItemPipeline/types";
import { showRevertConfirm } from "../components/RevertConfirmDialog";

const log = createLogger("useRestoreCheckpoint");

const TRUNCATION_GUARD_CLEAR_DELAY_MS = 500;
const USER_MESSAGE_EVENT_ID_PREFIX = "user-message-";

function agentMessageIdFromUserEventId(eventId: string): string | undefined {
  return eventId.startsWith(USER_MESSAGE_EVENT_ID_PREFIX)
    ? eventId.slice(USER_MESSAGE_EVENT_ID_PREFIX.length)
    : undefined;
}

export function useRestoreCheckpoint(): (
  chatItem: OptimizedChatItem
) => Promise<void> {
  const setEditTruncation = useSetAtom(editTruncationTimestampAtom);
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
  const clearTodosForSession = useSetAtom(clearTodosForSessionAtom);
  const store = useStore();
  const resolveCurrentSessionId = useCallback(
    () => store.get(activeSessionIdAtom) ?? store.get(sessionIdAtom),
    [store]
  );
  const { t } = useTranslation("sessions");

  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        clearTimeout(clearTimerRef.current);
        clearTimerRef.current = null;
      }
    };
  }, []);

  return useCallback(
    async (chatItem: OptimizedChatItem) => {
      const initiatedSessionId = resolveCurrentSessionId();
      const isStillOnInitiatingSession = (): boolean => {
        if (!initiatedSessionId) return false;
        const activeSessionId = store.get(activeSessionIdAtom);
        if (activeSessionId) return activeSessionId === initiatedSessionId;
        return store.get(sessionIdAtom) === initiatedSessionId;
      };

      const dbEventId = chatItem.event?.id ?? null;
      const eventId = dbEventId ?? chatItem.chunk_id;
      if (!eventId) return;

      const createdAt = chatItem.event?.createdAt;
      let revertFiles = true;

      if (
        initiatedSessionId &&
        createdAt &&
        (isAgentSession(initiatedSessionId) || isCliSession(initiatedSessionId))
      ) {
        try {
          const hasChanges = await checkSnapshotChanges(
            initiatedSessionId,
            createdAt
          );
          if (!isStillOnInitiatingSession()) return;
          if (hasChanges) {
            const choice = await showRevertConfirm();
            if (!isStillOnInitiatingSession()) return;
            if (choice === "cancel") return;
            revertFiles = choice === "revert";
          }
        } catch (err) {
          log.warn(
            "[useRestoreCheckpoint] checkSnapshotChanges failed, proceeding with revert:",
            err
          );
          Message.warning(t("errors.failedToCheckChanges"));
        }
      }

      if (
        initiatedSessionId &&
        !dbEventId &&
        isAgentSession(initiatedSessionId)
      ) {
        log.error(
          "[useRestoreCheckpoint] dbEventId is null for agent session — SQLite truncate will be skipped. " +
            "The restore will appear to work but history will reappear after reload.",
          {
            sessionId: initiatedSessionId,
            chunkId: chatItem.chunk_id,
          }
        );
      }

      try {
        if (createdAt) {
          setEditTruncation(createdAt);
        }
        // Land the turn FSM at idle and leave it there: unlike edit-resend,
        // restore has no follow-up dispatch, so we must NOT flip back to an
        // optimistic running state — the session rests at the checkpoint.
        if (initiatedSessionId) {
          await cancelTurnForTimelineBoundary(initiatedSessionId, "rewind");
        }

        await eventStoreProxy.truncateBeforeId(
          eventId,
          initiatedSessionId ?? undefined
        );

        if (initiatedSessionId && createdAt) {
          if (isAgentSession(initiatedSessionId)) {
            await truncateAfterMessage(initiatedSessionId, createdAt, {
              revertFiles,
              messageId: agentMessageIdFromUserEventId(eventId),
            });
          } else if (isCliSession(initiatedSessionId)) {
            await invokeTauri<number>("cli_agent_truncate_after_chunk", {
              sessionId: initiatedSessionId,
              createdAt,
              revertFiles,
            });
          }
          // Truncate the session-persistence `events` cache (and rebuild its
          // turn index) at the same checkpoint. The live in-memory store was
          // already truncated by `truncateBeforeId` above and the authoritative
          // source (agent_messages / code_session_chunks) by the calls above,
          // but the cached `events` rows survive untouched. Edit-resend gets
          // away without this because its follow-up resend writes fresh events
          // that overwrite the cache; restore has no resend, so a later reload
          // would rehydrate the stale pre-restore tail from this cache. Unlike
          // eviction, this keeps the live store intact — it only realigns the
          // persisted cache with the checkpoint.
          await truncateCacheAfterEvent(initiatedSessionId, eventId).catch(
            (err) =>
              log.warn(
                "[useRestoreCheckpoint] cache truncate failed (non-fatal):",
                err
              )
          );

          // Realign the orgtrack ledger with the checkpoint. The Workstation
          // "Diff (N)" panel reads orgtrack's own tables (final_diffs /
          // diff_chunks / commit_links), which restore does not touch directly
          // — so without this the panel keeps listing every file the session
          // ever edited, even ones we just reverted. We invalidate (delete) the
          // session's derived rows rather than recomputing them: the panel then
          // shows the clean post-checkpoint state, and the live runtime path
          // repopulates the tables as the user makes new edits. Non-fatal: a
          // stale panel is better than a failed restore.
          await deleteOrgtrackSessionArtifacts(initiatedSessionId).catch(
            (err) =>
              log.warn(
                "[useRestoreCheckpoint] orgtrack invalidation failed (non-fatal):",
                err
              )
          );
        }

        if (initiatedSessionId) {
          setPendingPlanApprovals((prev) =>
            clearPendingPlanApproval(prev, initiatedSessionId)
          );
          clearTodosForSession(initiatedSessionId);
        }
      } catch (err) {
        log.error("[useRestoreCheckpoint] restore truncate failed:", err);
        Message.error(t("errors.errorOccurred"));
      } finally {
        if (clearTimerRef.current !== null) {
          clearTimeout(clearTimerRef.current);
        }
        clearTimerRef.current = setTimeout(() => {
          setEditTruncation(null);
          clearTimerRef.current = null;
        }, TRUNCATION_GUARD_CLEAR_DELAY_MS);
      }
    },
    [
      setEditTruncation,
      setPendingPlanApprovals,
      clearTodosForSession,
      resolveCurrentSessionId,
      t,
      store,
    ]
  );
}
