import { useSetAtom } from "jotai";
import throttle from "lodash/throttle";
import { useTranslation } from "react-i18next";

import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import { updateEventByIdAtom, useStepState } from "@src/engines/SessionCore";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { createLogger } from "@src/hooks/logger";

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
      } catch (error) {
        log.error("Error replying to question:", error);
        Message.error(t("toasts.replyError"));
      }
    },
    1000
  );

  const handleIgnoreQuestion = (chunkId: string) => {
    rejectQuestion(sessionId, chunkId).catch(() => {});

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
