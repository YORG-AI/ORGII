import { useSetAtom } from "jotai";
import throttle from "lodash/throttle";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";

import {
  createUnifiedSessionApi,
  isHostedFromSearchParams,
} from "@src/api/http/session/unified";
import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { updateEventByIdAtom, useStepState } from "@src/engines/SessionCore";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { createLogger } from "@src/hooks/logger";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

const log = createLogger("useReplyQuestion");

/**
 * Reply / ignore handlers for inline `Q` chat items rendered by
 * `AskUserChatItem`. Wired into `ChatHistory` via `useChatHistoryState`
 * — see `docs/session/chatpanel-session-flows--0410.md` for
 * the full call chain.
 *
 * Scope is intentionally narrow: this hook only handles the *answer
 * submission* and *ignore* paths for an active question. The separate
 * "compose a reply pinned to a chunk" UX is owned by
 * `useSessionReplyField` (per-session persisted) and is not wired
 * through here.
 */
const useReplyQuestion = () => {
  const { t } = useTranslation();
  const updateEventById = useSetAtom(updateEventByIdAtom);
  const { setIsStepWaiting } = useStepState();

  const [searchParams] = useSearchParams();

  const isHosted = useMemo(
    () => isHostedFromSearchParams(searchParams),
    [searchParams]
  );
  const api = useMemo(() => createUnifiedSessionApi(isHosted), [isHosted]);

  const { sessionId: resolvedId } = useSessionId();
  const sessionId = resolvedId || "";

  const handleReplyQuestion = throttle(
    async ({ reply, chunk_id }: { reply: string; chunk_id: string }) => {
      try {
        if (!reply.trim()) {
          Message.error(t("toasts.replyEmpty"));
          return;
        }

        if (!sessionId) {
          Message.error(t("toasts.sessionNotFound"));
          return;
        }

        // Agent and CLI sessions: use unified agent API
        if (isAgentSession(sessionId) || isCliSession(sessionId)) {
          await respondQuestion(sessionId, chunk_id, [[reply.trim()]]);
          updateEventById({
            id: chunk_id,
            updater: (event) => ({
              ...event,
              result: { ...event.result, status: "responsed" },
              displayStatus: "completed" as const,
            }),
          });
          setIsStepWaiting(false);
          Message.success(t("toasts.answerSubmitted"));
          return;
        }

        // Backend (HTTP) sessions: Use Session API
        const res = await api.answerQuestion(sessionId, {
          question_id: chunk_id,
          answer: reply,
        });

        const response = res as
          | { status?: number; data?: { success?: boolean } }
          | undefined;
        if (response?.status === 0 && response?.data?.success) {
          updateEventById({
            id: chunk_id,
            updater: (event) => ({
              ...event,
              result: { ...event.result, status: "responsed" },
              displayStatus: "completed" as const,
            }),
          });
          setIsStepWaiting(false);
          Message.success(t("toasts.answerSubmitted"));
        } else {
          Message.error(t("toasts.answerFailed"));
        }
      } catch (error) {
        log.error("Error replying to question:", error);
        Message.error(t("toasts.replyError"));
      }
    },
    1000
  );

  const handleIgnoreQuestion = (chunkId: string) => {
    if (isAgentSession(sessionId) || isCliSession(sessionId)) {
      rejectQuestion(sessionId, chunkId).catch(() => {});
    }

    updateEventById({
      id: chunkId,
      updater: (event) => ({
        ...event,
        result: { ...event.result, status: "ignored" },
        displayStatus: "completed" as const,
      }),
    });

    Message.info(t("toasts.questionIgnored"));
  };

  return {
    handleReplyQuestion,
    handleIgnoreQuestion,
  };
};

export default useReplyQuestion;
export { useReplyQuestion };
