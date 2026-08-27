/**
 * Native DOM event wiring for ComposerInput.
 *
 * Attaches the contenteditable host's non-React-synthesized event listeners
 * (composition, `beforeinput`, paste, drop, dragover, cut, copy, keydown)
 * plus the document-level `selectionchange` listener that keeps pill
 * "covered by selection" styling in sync, and tears them all down on
 * cleanup. Kept as one effect so the listener wiring/teardown pairing stays
 * easy to audit.
 */
import { useEffect } from "react";

import { hasReferenceDragData } from "@src/shared/dnd/referenceDragData";

import { removePillForDeleteDirection } from "./keyboard";
import type { UseEditorOperationsResult } from "./useEditorOperations";
import { extractSerializedTextFromRange, sanitizeText } from "./utils";

export interface UseComposerNativeEventsParams {
  hostRef: React.MutableRefObject<HTMLDivElement | null>;
  ops: UseEditorOperationsResult;
  isComposingRef: React.MutableRefObject<boolean>;
  compositionEndedAtRef: React.MutableRefObject<number>;
  handlePaste: (event: ClipboardEvent) => boolean;
  handleDrop: (event: DragEvent) => boolean;
  handleCut: (event: ClipboardEvent) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
  handleInput: (nativeEvent?: Event) => void;
  undoAndNotify: () => boolean;
  redoAndNotify: () => boolean;
  updateCoveredPillSelection: () => void;
}

/**
 * Wires every native (non-React) event listener the composer host needs.
 * Extracted verbatim from `ComposerInput/index.tsx`.
 */
export function useComposerNativeEvents({
  hostRef,
  ops,
  isComposingRef,
  compositionEndedAtRef,
  handlePaste,
  handleDrop,
  handleCut,
  handleKeyDown,
  handleInput,
  undoAndNotify,
  redoAndNotify,
  updateCoveredPillSelection,
}: UseComposerNativeEventsParams): void {
  const {
    markHistoryBoundary,
    commitHistoryBoundary,
    reconcilePillsFromDom,
    insertTextAtCaret,
  } = ops;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handleCompositionStart = () => {
      isComposingRef.current = true;
    };
    const handleCompositionEnd = () => {
      isComposingRef.current = false;
      compositionEndedAtRef.current = performance.now();
    };
    const handleBeforeInput = (event: InputEvent) => {
      if (isComposingRef.current) return;

      // WebKit may express Edit → Undo/Redo (including Cmd+Z) solely as a
      // beforeinput history event. Browser-native history cannot restore
      // our programmatically inserted, React-backed pills, so route both
      // forms through the composer's structured snapshot history.
      if (event.inputType === "historyUndo") {
        event.preventDefault();
        undoAndNotify();
        return;
      }
      if (event.inputType === "historyRedo") {
        event.preventDefault();
        redoAndNotify();
        return;
      }

      markHistoryBoundary();
      if (event.inputType.startsWith("deleteContent")) {
        const direction = event.inputType.endsWith("Forward")
          ? "forward"
          : "backward";
        if (removePillForDeleteDirection(host, direction, false)) {
          event.preventDefault();
          reconcilePillsFromDom();
          commitHistoryBoundary();
          handleInput();
          return;
        }
      }
      if (event.inputType === "insertText" && event.data) {
        const sanitized = sanitizeText(event.data);
        if (sanitized !== event.data) {
          event.preventDefault();
          if (sanitized) insertTextAtCaret(sanitized);
          commitHistoryBoundary();
          handleInput();
        }
      }
    };
    const handlePasteEvent = (event: ClipboardEvent) => {
      markHistoryBoundary();
      if (handlePaste(event)) {
        commitHistoryBoundary();
        handleInput();
      }
    };
    const handleDropEvent = (event: DragEvent) => {
      // Always prevent browser default drop behavior on the contenteditable
      // host. OS file drops are handled by GlobalDragDrop → droppedFilesAtom
      // → useDroppedFilesConsumer which inserts a pill; letting the browser
      // also insert the file name/path as raw text would corrupt the editor
      // and, in certain timing windows, produce an empty conversation round.
      event.preventDefault();
      markHistoryBoundary();
      if (handleDrop(event)) {
        commitHistoryBoundary();
        handleInput();
      }
    };
    const handleDragOverEvent = (event: DragEvent) => {
      const hasReferenceType = hasReferenceDragData(
        event.dataTransfer ? Array.from(event.dataTransfer.types) : undefined
      );
      if (hasReferenceType) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
    };
    const handleCutEvent = (event: ClipboardEvent) => {
      handleCut(event);
    };
    const handleCopyEvent = (event: ClipboardEvent) => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      if (!host.contains(range.commonAncestorContainer)) return;
      const text = extractSerializedTextFromRange(range);
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
    };
    host.addEventListener("compositionstart", handleCompositionStart);
    host.addEventListener("compositionend", handleCompositionEnd);
    host.addEventListener("beforeinput", handleBeforeInput);
    host.addEventListener("paste", handlePasteEvent);
    host.addEventListener("drop", handleDropEvent);
    host.addEventListener("dragover", handleDragOverEvent);
    host.addEventListener("cut", handleCutEvent);
    host.addEventListener("copy", handleCopyEvent);
    host.addEventListener("keydown", handleKeyDown);
    document.addEventListener("selectionchange", updateCoveredPillSelection);
    return () => {
      host.removeEventListener("compositionstart", handleCompositionStart);
      host.removeEventListener("compositionend", handleCompositionEnd);
      host.removeEventListener("beforeinput", handleBeforeInput);
      host.removeEventListener("paste", handlePasteEvent);
      host.removeEventListener("drop", handleDropEvent);
      host.removeEventListener("dragover", handleDragOverEvent);
      host.removeEventListener("cut", handleCutEvent);
      host.removeEventListener("copy", handleCopyEvent);
      host.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener(
        "selectionchange",
        updateCoveredPillSelection
      );
    };
  }, [
    hostRef,
    isComposingRef,
    compositionEndedAtRef,
    markHistoryBoundary,
    commitHistoryBoundary,
    reconcilePillsFromDom,
    insertTextAtCaret,
    handlePaste,
    handleDrop,
    handleCut,
    handleKeyDown,
    handleInput,
    redoAndNotify,
    undoAndNotify,
    updateCoveredPillSelection,
  ]);
}
