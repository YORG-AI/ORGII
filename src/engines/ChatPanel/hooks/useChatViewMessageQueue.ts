import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import {
  dequeueMessageAtom,
  editMessageAtom,
  enqueueCountAtom,
  forceSendMessageAtom,
  messageQueueAtom,
  queueFlushRequestAtom,
  reorderQueueAtom,
} from "@src/store/ui/messageQueueAtom";

import { useQueueEditMode } from "../InputArea/hooks/useQueueEditMode";

/** Keeps queue filtering and global-index reordering consistent for ChatView. */
export function useChatViewMessageQueue({
  pipelineSessionId,
  queueSessionId,
}: {
  pipelineSessionId: string | null;
  queueSessionId: string | null;
}) {
  const messageQueue = useAtomValue(messageQueueAtom);
  const sessionMessageQueue = useMemo(
    () =>
      messageQueue.filter(
        (message) =>
          message.sessionId === queueSessionId ||
          message.sessionId === pipelineSessionId
      ),
    [messageQueue, pipelineSessionId, queueSessionId]
  );
  const enqueueCount = useAtomValue(enqueueCountAtom);
  const cancelQueuedMessage = useSetAtom(dequeueMessageAtom);
  const editQueuedMessage = useSetAtom(editMessageAtom);
  const reorderQueue = useSetAtom(reorderQueueAtom);
  const forceSendQueuedMessage = useSetAtom(forceSendMessageAtom);
  const setQueueFlushRequest = useSetAtom(queueFlushRequestAtom);

  const handleSendNow = useCallback(
    (messageId: string) => {
      const message = messageQueue.find((item) => item.id === messageId);
      if (!message) return;
      forceSendQueuedMessage(messageId);
      setQueueFlushRequest((requestId) => requestId + 1);
    },
    [messageQueue, forceSendQueuedMessage, setQueueFlushRequest]
  );

  const handleCommitQueueEdit = useCallback(
    (messageId: string, content: string, imageDataUrls?: string[]) => {
      editQueuedMessage({ messageId, content, imageDataUrls });
    },
    [editQueuedMessage]
  );

  const handleReorderSessionQueue = useCallback(
    (fromIndex: number, toIndex: number) => {
      const fromMessage = sessionMessageQueue[fromIndex];
      const toMessage = sessionMessageQueue[toIndex];
      if (!fromMessage || !toMessage) return;
      const globalFromIndex = messageQueue.findIndex(
        (message) => message.id === fromMessage.id
      );
      const globalToIndex = messageQueue.findIndex(
        (message) => message.id === toMessage.id
      );
      reorderQueue({ fromIndex: globalFromIndex, toIndex: globalToIndex });
    },
    [messageQueue, reorderQueue, sessionMessageQueue]
  );

  const queueEditProps = useQueueEditMode({
    onCommit: handleCommitQueueEdit,
    onCommitSendNow: handleSendNow,
  });

  return {
    cancelQueuedMessage,
    enqueueCount,
    handleReorderSessionQueue,
    handleSendNow,
    queueEditProps,
    sessionMessageQueue,
  };
}
