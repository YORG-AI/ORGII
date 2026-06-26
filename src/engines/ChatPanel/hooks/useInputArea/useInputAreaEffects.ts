/**
 * useInputAreaEffects
 *
 * Manages all side effects for the InputArea
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  type MutableRefObject,
  type RefObject,
  useEffect,
  useRef,
} from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import { useAddToAgentInsertion } from "@src/hooks/input/useAddToAgentInsertion";
import i18n from "@src/i18n";
import {
  restoreToInputAtom,
  sessionRolledBackAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import {
  type ChatImageAttachment,
  chatImageAttachmentsAtom,
} from "@src/store/ui/chatImageAtom";
import { prewarmFileIndex } from "@src/util/platform/tauri/fileSearch";

import { useDroppedFilesConsumer } from "./useDroppedFilesConsumer";
import { useImageAttachment } from "./useImageAttachment";

const MENU_OUTSIDE_CLICK_GRACE_MS = 120;

interface UseInputAreaEffectsOptions {
  // Refs
  composerInputRef: RefObject<ComposerInputRef | null>;
  containerRef: RefObject<HTMLDivElement | null>;
  dropTargetId: string;
  hasContentRef: MutableRefObject<boolean>;

  // State
  showContextMenu: boolean;
  setShowContextMenu: (show: boolean) => void;

  // Cite code
  isCiteCode: boolean;
  selectedCiteText: string;
  selectedCiteRange: { start: number; end: number } | null;
  citeFileName: string;

  // Repo path for debug logging
  currentRepoPath: string | undefined;

  withProgrammaticInputMutation?: (mutation: () => void) => void;
  onRestoreInputContent?: (text: string) => void;
}

export function useInputAreaEffects(options: UseInputAreaEffectsOptions): void {
  const {
    composerInputRef,
    containerRef,
    dropTargetId,
    hasContentRef,
    showContextMenu,
    setShowContextMenu,
    isCiteCode,
    selectedCiteText,
    selectedCiteRange,
    citeFileName,
    currentRepoPath,
    withProgrammaticInputMutation,
    onRestoreInputContent,
  } = options;

  // Image attachments — unified entry point for paste / upload / drag-drop
  // images. `handleImagePath` reads bytes from a filesystem path and routes
  // them through the same optimize pipeline as `handleImagePaste`.
  const { handleImagePaste, handleImagePath } =
    useImageAttachment(dropTargetId);

  useDroppedFilesConsumer({
    composerInputRef,
    dropTargetId,
    hasContentRef,
    handleImagePaste,
    handleImagePath,
  });

  // Restore-to-input signal set by the cancel-restore path after a
  // user-initiated cancel. We push the message back into the editor so
  // the user can edit/resend, then clear the signal.
  //
  // When sessionRolledBack is true (Case 1: first-send cancel), the atom
  // is reserved for SessionCreatorChatPanel to consume on mount — skip here
  // so the old session's InputArea doesn't swallow it before unmounting.
  const restoreToInput = useAtomValue(restoreToInputAtom);
  const setRestoreToInput = useSetAtom(restoreToInputAtom);
  const sessionRolledBack = useAtomValue(sessionRolledBackAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  const setImageAttachments = useSetAtom(chatImageAttachmentsAtom);
  useEffect(() => {
    if (!restoreToInput || sessionRolledBack) return;
    // Only consume restore payloads targeting this session. Without this
    // guard, a cancel in session B could leak its prompt into session A's
    // composer when both are mounted (e.g. side-by-side panels).
    if (activeSessionId && restoreToInput.sessionId !== activeSessionId) {
      return;
    }

    const editor = composerInputRef.current;
    if (!editor) {
      return;
    }

    const current = editor.getText();
    const next =
      current.trim().length > 0
        ? `${restoreToInput.displayContent}\n${current}`
        : restoreToInput.displayContent;

    const restoreMutation = () => {
      editor.setContent(next);
      hasContentRef.current = next.trim().length > 0;
      onRestoreInputContent?.(next);
    };
    if (withProgrammaticInputMutation) {
      withProgrammaticInputMutation(restoreMutation);
    } else {
      restoreMutation();
    }

    // Restore image attachments that were captured before the cancel.
    // Data URLs are already optimized, so we reconstruct ChatImageAttachment
    // objects directly without re-running the optimize pipeline.
    if (
      restoreToInput.imageDataUrls &&
      restoreToInput.imageDataUrls.length > 0
    ) {
      const restored: ChatImageAttachment[] = restoreToInput.imageDataUrls.map(
        (dataUrl, idx) => ({
          id: `restored_${Date.now()}_${idx}`,
          dataUrl,
          fileName: `restored-image-${idx + 1}.png`,
          size: 0,
          width: 0,
          height: 0,
          ownerId: dropTargetId,
        })
      );
      setImageAttachments((prev) => [
        ...prev.filter((image) => image.ownerId !== dropTargetId),
        ...restored,
      ]);
    }

    setRestoreToInput(null);
  }, [
    restoreToInput,
    sessionRolledBack,
    activeSessionId,
    setRestoreToInput,
    setImageAttachments,
    dropTargetId,
    withProgrammaticInputMutation,
    onRestoreInputContent,
    composerInputRef,
    hasContentRef,
  ]);

  const menuOpenedAtRef = useRef(0);

  // Click outside handler for @ dropdown. The menu is rendered through a
  // document.body portal, so check both the portal shell and the composer shell.
  useEffect(() => {
    if (!showContextMenu) return;

    menuOpenedAtRef.current = performance.now();
    let portalReady = false;
    const readyFrame = window.requestAnimationFrame(() => {
      portalReady = true;
    });

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        performance.now() - menuOpenedAtRef.current <
        MENU_OUTSIDE_CLICK_GRACE_MS
      ) {
        return;
      }

      const ownerContainer = containerRef.current;
      if (ownerContainer?.contains(target)) return;

      const portalShell = document.querySelector("[data-context-menu-portal]");
      if (!portalShell && !portalReady) return;
      if (portalShell?.contains(target)) return;
      setShowContextMenu(false);
    };

    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      window.cancelAnimationFrame(readyFrame);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [containerRef, showContextMenu, setShowContextMenu]);

  // Pre-warm file search index when workspace path changes.
  // Starting immediately avoids the common cold-search race where the user
  // types @file before a delayed prewarm has had a chance to build the cache.
  useEffect(() => {
    if (!currentRepoPath) return;

    prewarmFileIndex(currentRepoPath).catch(() => {
      // Non-fatal — logged inside prewarmFileIndex already.
    });
  }, [currentRepoPath]);

  // Insert file reference pill when code is cited (Add to Chat)
  // Line range like @index.tsx (1-483)
  useEffect(() => {
    if (
      !isCiteCode ||
      !selectedCiteText ||
      !selectedCiteRange ||
      !citeFileName
    ) {
      return;
    }

    const insertTimer = setTimeout(() => {
      if (composerInputRef.current) {
        // citeFileName contains the full file path (e.g., /path/to/file.tsx)
        // Extract just the filename for display
        const displayFileName = citeFileName.split("/").pop() || citeFileName;

        // Insert file reference with line range like @index.tsx (1-483)
        composerInputRef.current.insertFileReference({
          filePath: citeFileName,
          fileName: displayFileName,
          lineStart: selectedCiteRange.start,
          lineEnd: selectedCiteRange.end,
        });
      }
      composerInputRef.current?.focus();
    }, 100);

    return () => clearTimeout(insertTimer);
  }, [
    isCiteCode,
    selectedCiteText,
    selectedCiteRange,
    citeFileName,
    composerInputRef,
  ]);

  // Listen for internal file drop events dispatched by GlobalDragDrop
  useEffect(() => {
    // Handler for custom event (dispatched by GlobalDragDrop)
    const handleInternalFileDrop = (event: Event) => {
      const customEvent = event as CustomEvent<{ fileRefData: string }>;
      processFileRefData(customEvent.detail.fileRefData);
    };

    // Shared logic to process file reference data
    const processFileRefData = (fileRefData: string | undefined) => {
      if (!fileRefData) {
        return;
      }

      let fileRef: { path: string; name: string; type: string };
      try {
        fileRef = JSON.parse(fileRefData);
      } catch (_parseError) {
        return;
      }

      if (!fileRef.path) {
        return;
      }

      const insertPill = () => {
        if (!composerInputRef.current) {
          return;
        }

        const isFolder = fileRef.type === "directory";
        composerInputRef.current.insertFilePill(
          fileRef.path,
          isFolder,
          isFolder ? "folder" : "file"
        );
        Message.success(
          i18n.t("toasts.addedAsContext", { name: fileRef.name })
        );
      };

      insertPill();
    };

    // Listen for custom event dispatched by GlobalDragDrop
    document.addEventListener("internal-file-drop", handleInternalFileDrop);

    return () => {
      document.removeEventListener(
        "internal-file-drop",
        handleInternalFileDrop
      );
    };
  }, [composerInputRef]);

  // Consume pending "add-to-agent" requests — shared with SessionCreator.
  useAddToAgentInsertion(composerInputRef);
}
