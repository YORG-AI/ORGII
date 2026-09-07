/**
 * useQueueEditMode
 *
 * Shared hook for queue message editing in the main input box.
 * Reads/writes queueEditTargetAtom and returns props ready to spread onto InputArea.
 *
 * @param onCommit — called with (messageId, newContent, imageDataUrls) when the user submits.
 *                   Callers use this to persist the edit (atom write, local state, etc.).
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { queueEditTargetAtom } from "@src/store/ui/messageQueueAtom";

interface UseQueueEditModeOptions {
  onCommit: (
    messageId: string,
    content: string,
    imageDataUrls?: string[]
  ) => boolean | void;
  onCommitSendNow?: (messageId: string) => void;
}

export interface QueueEditInputAreaProps {
  isEditMode: boolean;
  initialContent: string | undefined;
  editImages: string[] | undefined;
  onEditSubmit: (text: string, imageDataUrls?: string[]) => void;
  onEditSendNow?: (text: string, imageDataUrls?: string[]) => void;
  onEditCancel: () => void;
  editLabel: string | undefined;
  showEditHeader: boolean;
}

export function useQueueEditMode({
  onCommit,
  onCommitSendNow,
}: UseQueueEditModeOptions): QueueEditInputAreaProps {
  const { t } = useTranslation("sessions");
  const queueEditTarget = useAtomValue(queueEditTargetAtom);
  const setQueueEditTarget = useSetAtom(queueEditTargetAtom);

  const commitEdit = useCallback(
    (text: string, addedImageDataUrls?: string[]): string | null => {
      if (!queueEditTarget) return null;
      const imageDataUrls = [
        ...(queueEditTarget.imageDataUrls ?? []),
        ...(addedImageDataUrls ?? []),
      ];
      const committed = onCommit(
        queueEditTarget.messageId,
        text,
        imageDataUrls.length > 0 ? imageDataUrls : undefined
      );
      return committed === false ? null : queueEditTarget.messageId;
    },
    [queueEditTarget, onCommit]
  );

  const onEditSubmit = useCallback(
    (text: string, addedImageDataUrls?: string[]) => {
      if (commitEdit(text, addedImageDataUrls)) setQueueEditTarget(null);
    },
    [commitEdit, setQueueEditTarget]
  );

  const onEditSendNow = useCallback(
    (text: string, addedImageDataUrls?: string[]) => {
      const messageId = commitEdit(text, addedImageDataUrls);
      if (messageId) {
        setQueueEditTarget(null);
        onCommitSendNow?.(messageId);
      }
    },
    [commitEdit, onCommitSendNow, setQueueEditTarget]
  );

  const onEditCancel = useCallback(() => {
    setQueueEditTarget(null);
  }, [setQueueEditTarget]);

  return {
    isEditMode: !!queueEditTarget,
    initialContent: queueEditTarget?.content,
    editImages: queueEditTarget?.imageDataUrls,
    onEditSubmit,
    onEditSendNow,
    onEditCancel,
    editLabel: queueEditTarget ? t("input.editingQueuedMessage") : undefined,
    showEditHeader: false,
  };
}
