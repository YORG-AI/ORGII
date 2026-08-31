/**
 * useEditMode Hook
 *
 * Encapsulates edit mode logic for InputArea:
 * - Initial content injection with retry (waits for ComposerInput init)
 * - Parses serialized pill format back into ComposerInput filePill nodes
 * - Submit and cancel handlers
 * - Click-outside-to-close behavior
 * - Escape key handler
 */
import React, { useCallback, useEffect, useRef } from "react";

import type { ComposerSnapshot } from "@src/components/ComposerInput/types";
import { stripLeadingBlankLines } from "@src/util/data/stripLeadingBlankLines";

import { applyParsedContent } from "../utils/pillContentParser";

// ============================================
// Hook
// ============================================

interface UseEditModeOptions {
  /** Whether edit mode is active */
  effectiveEditMode: boolean;
  /** Same as effectiveEditMode (kept for draft-save gating) */
  isEditMode: boolean;
  /** Initial text to pre-fill */
  initialContent?: string;
  /** Callback when edit is submitted */
  onEditSubmit?: (text: string, imageDataUrls?: string[]) => void;
  /** Images newly attached while editing */
  attachedImageDataUrls?: string[];
  /**
   * Clears the composer's attached-image atom after a successful submit.
   * Without this, images pasted during a queue/sent-message edit stay in
   * `chatImageAttachmentsAtom` after they've been folded into the message —
   * the strip re-renders next to `editImages` on the next edit (stacked
   * duplicate) and every subsequent Save folds another copy in.
   */
  clearAttachedImages?: () => void;
  /** Callback when edit is cancelled */
  onEditCancel?: () => void;
  /** Ref to the ComposerInput editor handle */
  composerInputRef: React.RefObject<{
    getEditor: () => unknown | null;
    setContent: (content: string | ComposerSnapshot) => void;
    getText: () => string;
    getTextWithPills: () => string;
    focus: () => void;
  } | null>;
}

interface UseEditModeReturn {
  /** Ref to attach to the edit container (for click-outside detection) */
  editContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Submit handler for edit mode */
  handleEditSubmit: () => void;
  /** KeyDown handler for Escape to cancel */
  handleEditKeyDown: (event: React.KeyboardEvent) => void;
}

export function useEditMode({
  effectiveEditMode,
  isEditMode,
  initialContent,
  onEditSubmit,
  attachedImageDataUrls = [],
  clearAttachedImages,
  onEditCancel,
  composerInputRef,
}: UseEditModeOptions): UseEditModeReturn {
  const editContainerRef = useRef<HTMLDivElement>(null);
  const savedDraftRef = useRef<string | null>(null);

  // Save current draft before entering edit mode, restore when leaving
  useEffect(() => {
    if (!isEditMode) return;

    const editor = composerInputRef.current;
    const currentText = editor?.getTextWithPills()?.trim() ?? "";
    savedDraftRef.current = currentText || null;

    return () => {
      if (!editor) return;
      const draft = savedDraftRef.current;
      savedDraftRef.current = null;
      if (draft) {
        applyParsedContent(editor, draft);
      } else {
        editor.setContent("");
      }
    };
  }, [isEditMode, composerInputRef]);

  // Set initial content with retry (ComposerInput may not be ready immediately)
  useEffect(() => {
    if (!effectiveEditMode || !initialContent) return;

    let cancelled = false;
    let attempts = 0;
    const MAX_ATTEMPTS = 20;
    const RETRY_INTERVAL_MS = 50;

    const trySetContent = () => {
      if (cancelled || attempts >= MAX_ATTEMPTS) return;
      attempts++;

      if (!composerInputRef.current?.getEditor()) {
        setTimeout(trySetContent, RETRY_INTERVAL_MS);
        return;
      }

      applyParsedContent(
        composerInputRef.current,
        stripLeadingBlankLines(initialContent)
      );
      if (isEditMode) {
        setTimeout(() => composerInputRef.current?.focus(), 50);
      }
    };

    trySetContent();

    return () => {
      cancelled = true;
    };
  }, [effectiveEditMode, isEditMode, initialContent, composerInputRef]);

  // Handle edit mode submit
  const handleEditSubmit = useCallback(() => {
    if (composerInputRef.current && onEditSubmit) {
      // Use getTextWithPills to preserve pill serialization format
      const text = composerInputRef.current.getTextWithPills().trim();
      if (text) {
        onEditSubmit(
          text,
          attachedImageDataUrls.length > 0 ? attachedImageDataUrls : undefined
        );
        // The images are now part of the edited message — drop them from
        // the composer attachment atom so they aren't shown (or re-folded)
        // a second time.
        if (attachedImageDataUrls.length > 0) clearAttachedImages?.();
      }
    }
  }, [
    attachedImageDataUrls,
    clearAttachedImages,
    onEditSubmit,
    composerInputRef,
  ]);

  // Handle edit mode cancel (Escape key)
  const handleEditKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Escape" && onEditCancel) {
        event.preventDefault();
        onEditCancel();
      }
    },
    [onEditCancel]
  );

  // Click outside to close edit mode.
  // Guard: do not close when the click lands inside a portal-rendered overlay
  // (e.g. the UnifiedModelPalette spotlight), which lives outside the
  // editContainerRef DOM tree even though it is logically part of the input UI.
  useEffect(() => {
    if (!isEditMode || !onEditCancel) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const targetElement =
        target instanceof Element ? target : target.parentElement;
      if (
        targetElement?.closest(
          "[data-spotlight-container], [data-dropdown-main-panel-anchor], [data-dropdown-side-panel-anchor], [data-context-menu-portal], [data-slash-portal]"
        )
      ) {
        return;
      }

      if (
        editContainerRef.current &&
        !editContainerRef.current.contains(target)
      ) {
        onEditCancel();
      }
    };

    // Add listener with a small delay to prevent immediate close
    const timeoutId = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isEditMode, onEditCancel]);

  return {
    editContainerRef,
    handleEditSubmit,
    handleEditKeyDown,
  };
}
