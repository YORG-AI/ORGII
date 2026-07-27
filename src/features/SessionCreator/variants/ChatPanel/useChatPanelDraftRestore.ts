/**
 * SessionCreatorChatPanel — Draft Restore & Content Tracking Hook
 *
 * Extracts the "restore text into composer" effect and the draft-has-content
 * tracking wrapper around `handleContentChange` from SessionCreatorChatPanel
 * to keep the component file under the 600-line limit.
 */
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { type RefObject, useCallback, useEffect, useState } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { restoreToInputAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  type ChatImageAttachment,
  chatImageAttachmentsAtom,
} from "@src/store/ui/chatImageAtom";
import { draftHasContentAtom } from "@src/store/ui/draftAtom";

interface UseChatPanelDraftRestoreOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  handleContentChange: (text: string) => void;
  setHumanNoteHasContent: (hasContent: boolean) => void;
}

export function useChatPanelDraftRestore({
  composerInputRef,
  handleContentChange,
  setHumanNoteHasContent,
}: UseChatPanelDraftRestoreOptions) {
  const store = useStore();

  // ── Restore text ──────────────────────────────────────────────────────────

  const restoreToInput = useAtomValue(restoreToInputAtom);
  const setImageAttachments = useSetAtom(chatImageAttachmentsAtom);
  const [initialRestoreText] = useState<string>(() => {
    return store.get(restoreToInputAtom)?.displayContent ?? "";
  });

  // ── Draft content tracking ────────────────────────────────────────────────

  const setDraftHasContent = useSetAtom(draftHasContentAtom);

  const handleContentChangeWithTracking = useCallback(
    (text: string) => {
      setDraftHasContent(text.trim().length > 0);
      setHumanNoteHasContent(text.trim().length > 0);
      handleContentChange?.(text);
    },
    [handleContentChange, setDraftHasContent, setHumanNoteHasContent]
  );

  useEffect(() => {
    if (!restoreToInput?.displayContent) return;
    const editor = composerInputRef.current;
    if (!editor) return;
    const restoredText = restoreToInput.displayContent;
    editor.setContent(restoredText);
    editor.focus();
    handleContentChangeWithTracking(restoredText);
    if (restoreToInput.imageDataUrls?.length) {
      const restoredImages: ChatImageAttachment[] =
        restoreToInput.imageDataUrls.map((dataUrl, idx) => ({
          id: `restored_${Date.now()}_${idx}`,
          dataUrl,
          fileName: `restored-image-${idx + 1}.png`,
          size: 0,
          width: 0,
          height: 0,
        }));
      setImageAttachments((prev) => [
        ...prev.filter((image) => image.ownerId),
        ...restoredImages,
      ]);
    }
    store.set(restoreToInputAtom, null);
    store.set(draftHasContentAtom, restoredText.trim().length > 0);
  }, [
    restoreToInput,
    composerInputRef,
    handleContentChangeWithTracking,
    setImageAttachments,
    store,
  ]);

  useEffect(() => {
    return () => {
      setDraftHasContent(false);
    };
  }, [setDraftHasContent]);

  return {
    handleContentChangeWithTracking,
    initialRestoreText,
  };
}
