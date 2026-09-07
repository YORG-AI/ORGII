import { useCallback, useEffect, useRef } from "react";

import type { ChatHistoryProps } from "../ChatHistory.types";
import type { OptimizedChatItem } from "../chatItemPipeline/types";
import type { UseChatHistoryStateReturn } from "./useChatHistoryState";
import { useEditUserMessage } from "./useEditUserMessage";
import { useRestoreCheckpoint } from "./useRestoreCheckpoint";

interface UseChatHistoryItemActionsOptions {
  displaySourceGroupIndices: number[];
  groupHeaders: (OptimizedChatItem | null)[];
  handleIgnoreQuestionRef: UseChatHistoryStateReturn["handleIgnoreQuestionRef"];
  handleReplyQuestionRef: UseChatHistoryStateReturn["handleReplyQuestionRef"];
  onFailedUserIntentRetry?: ChatHistoryProps["onFailedUserIntentRetry"];
  resolveFailedUserIntentDispatch?: ChatHistoryProps["resolveFailedUserIntentDispatch"];
}

/** Stabilizes history mutation callbacks passed into virtualized row renderers. */
export function useChatHistoryItemActions({
  displaySourceGroupIndices,
  groupHeaders,
  handleIgnoreQuestionRef,
  handleReplyQuestionRef,
  onFailedUserIntentRetry,
  resolveFailedUserIntentDispatch,
}: UseChatHistoryItemActionsOptions) {
  const handleEditUserMessage = useEditUserMessage(
    onFailedUserIntentRetry,
    resolveFailedUserIntentDispatch
  );
  const handleRestoreCheckpoint = useRestoreCheckpoint();
  const pinnedEditSubmitRef = useRef(handleEditUserMessage);
  useEffect(() => {
    pinnedEditSubmitRef.current = handleEditUserMessage;
  }, [handleEditUserMessage]);
  const handlePinnedEditSubmit = useCallback(
    (header: OptimizedChatItem, newText: string, imageDataUrls?: string[]) =>
      pinnedEditSubmitRef.current(header, newText, imageDataUrls),
    []
  );

  const pinnedRestoreRef = useRef(handleRestoreCheckpoint);
  useEffect(() => {
    pinnedRestoreRef.current = handleRestoreCheckpoint;
  }, [handleRestoreCheckpoint]);
  const handleHeaderRestoreCheckpoint = useCallback(
    (header: OptimizedChatItem) => pinnedRestoreRef.current(header),
    []
  );

  const regenerateStateRef = useRef({
    displaySourceGroupIndices,
    groupHeaders,
    handleEditUserMessage,
  });
  useEffect(() => {
    regenerateStateRef.current = {
      displaySourceGroupIndices,
      groupHeaders,
      handleEditUserMessage,
    };
  }, [displaySourceGroupIndices, groupHeaders, handleEditUserMessage]);
  const handleRegenerateGroup = useCallback((groupIndex: number) => {
    const current = regenerateStateRef.current;
    const sourceGroupIndex =
      current.displaySourceGroupIndices[groupIndex] ?? groupIndex;
    const header = current.groupHeaders[sourceGroupIndex];
    if (!header?.event) return;
    const originalText =
      typeof header.event.displayText === "string"
        ? header.event.displayText
        : "";
    if (!originalText.trim()) return;
    const images = (header.event.result as Record<string, unknown>)?.images as
      | string[]
      | undefined;
    void current.handleEditUserMessage(header, originalText, images);
  }, []);

  const handleSubmitAnswers = useCallback(
    (eventId: string, answers: Record<string, string>) => {
      handleReplyQuestionRef.current({
        reply: Object.values(answers).join("\n"),
        chunk_id: eventId,
      });
    },
    [handleReplyQuestionRef]
  );
  const handleIgnoreQuestion = useCallback(
    (eventId: string) => handleIgnoreQuestionRef.current(eventId),
    [handleIgnoreQuestionRef]
  );

  return {
    handleEditUserMessage,
    handleHeaderRestoreCheckpoint,
    handleIgnoreQuestion,
    handlePinnedEditSubmit,
    handleRegenerateGroup,
    handleSubmitAnswers,
  };
}
