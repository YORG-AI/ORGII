/**
 * useEditUserMessage Hook
 *
 * Handles editing a user message in the chat using a linear hard-delete
 * model:
 * 1. Checks whether file changes exist after the target message
 * 2. If so, shows a three-choice dialog (revert / keep / cancel)
 * 3. Sets a truncation guard to prevent sync effects from re-adding events
 * 4. Truncates the event and everything after it from SQLite
 * 5. Splices the event and all subsequent events from the live Rust store
 * 6. Optionally reverts files
 * 7. Re-submits the edited text as a new message
 */
import { useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  checkSnapshotChanges,
  truncateAfterMessage,
} from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { useUserIntentSubmit } from "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit";
import { editTruncationTimestampAtom } from "@src/engines/SessionCore";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { cancelTurnForTimelineBoundary } from "@src/engines/SessionCore/control/sessionTimelineBoundary";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { deleteSession as deleteCachedSession } from "@src/engines/SessionCore/storage/cacheAdapter";
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

const log = createLogger("useEditUserMessage");

const TRUNCATION_GUARD_CLEAR_DELAY_MS = 500;
const USER_MESSAGE_EVENT_ID_PREFIX = "user-message-";

function agentMessageIdFromUserEventId(eventId: string): string | undefined {
  return eventId.startsWith(USER_MESSAGE_EVENT_ID_PREFIX)
    ? eventId.slice(USER_MESSAGE_EVENT_ID_PREFIX.length)
    : undefined;
}

export function useEditUserMessage(): (
  chatItem: OptimizedChatItem,
  newText: string,
  imageDataUrls?: string[]
) => Promise<void> {
  const setEditTruncation = useSetAtom(editTruncationTimestampAtom);
  const setPendingPlanApprovals = useSetAtom(pendingPlanApprovalsAtom);
  const clearTodosForSession = useSetAtom(clearTodosForSessionAtom);
  const store = useStore();
  const resolveCurrentSessionId = useCallback(
    () => store.get(activeSessionIdAtom) ?? store.get(sessionIdAtom),
    [store]
  );
  const submitUserIntent = useUserIntentSubmit({
    getSessionId: resolveCurrentSessionId,
  });
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
    async (
      chatItem: OptimizedChatItem,
      newText: string,
      imageDataUrls?: string[]
    ) => {
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
            "[useEditUserMessage] checkSnapshotChanges failed, proceeding with revert:",
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
          "[useEditUserMessage] dbEventId is null for agent session — SQLite truncate will be skipped. " +
            "The edit will appear to work but history will reappear after reload.",
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
        if (initiatedSessionId) {
          await cancelTurnForTimelineBoundary(initiatedSessionId, "rewind");
          // The rewind boundary wrote `idle`; the truncate RPCs below can be
          // slow and a resend is guaranteed to follow, so flip back to
          // optimistic running now — otherwise the panel reads as frozen for
          // the whole truncate window (#14).
          beginOptimisticTurn(initiatedSessionId);
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
            // Purge the session-persistence cache and Rust EventStore so that
            // after a browser reload the session reloads from the authoritative
            // code_session_chunks SQLite table rather than from stale cached
            // events that predate the rewind.
            await Promise.all([
              deleteCachedSession(initiatedSessionId).catch((err) =>
                log.warn(
                  "[useEditUserMessage] deleteSession failed (non-fatal):",
                  err
                )
              ),
              eventStoreProxy
                .evictSession(initiatedSessionId)
                .catch((err) =>
                  log.warn(
                    "[useEditUserMessage] evictSession failed (non-fatal):",
                    err
                  )
                ),
            ]);
          }
        }

        if (initiatedSessionId) {
          setPendingPlanApprovals((prev) =>
            clearPendingPlanApproval(prev, initiatedSessionId)
          );
          clearTodosForSession(initiatedSessionId);
        }

        const resendImages =
          imageDataUrls && imageDataUrls.length > 0 ? imageDataUrls : undefined;
        await submitUserIntent({
          sessionId: initiatedSessionId,
          displayContent: newText,
          imageDataUrls: resendImages,
          source: "dispatch",
        });
      } catch (err) {
        log.error("[useEditUserMessage] edit truncate/resubmit failed:", err);
        if (initiatedSessionId) failOptimisticTurn(initiatedSessionId);
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
      submitUserIntent,
      t,
      store,
    ]
  );
}
