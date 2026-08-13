import { useCallback, useEffect, useRef } from "react";
import type React from "react";

import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";
import type { SlashItem } from "@src/types/extensions";

import type { ListEntry, OpenFlyoutState } from "./types";

interface UseKeyboardOptions {
  visible: boolean;
  entries: ListEntry[];
  totalFlat: number;
  highlightIndex: number;
  openFlyout: OpenFlyoutState | null;
  listRef: React.RefObject<HTMLDivElement | null>;
  setHighlightIndex: (idx: number) => void;
  setKeyboardNavigated: (navigated: boolean) => void;
  setOpenFlyout: (state: OpenFlyoutState | null) => void;
  onSelect: (item: SlashItem) => void;
  onModeSelect: (mode: ComposerModeEntry["id"]) => void;
  onImageUpload?: () => void;
  onClose: () => void;
  keyboardHandlerRef: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  /** Flyout child-panel highlight index (controlled by parent). */
  flyoutHighlightIndex: number;
  setFlyoutHighlightIndex: (idx: number) => void;
}

/**
 * Wires keyboard navigation (ArrowUp/Down, Enter, Tab, Escape) for the
 * slash command menu, including flyout open/close. The handler is stored in
 * `keyboardHandlerRef` so the parent editor can delegate key events without
 * React synthetic event plumbing.
 */
export function useKeyboard({
  visible,
  entries,
  totalFlat,
  highlightIndex,
  openFlyout,
  listRef,
  setHighlightIndex,
  setKeyboardNavigated,
  setOpenFlyout,
  onSelect,
  onModeSelect,
  onImageUpload,
  onClose,
  keyboardHandlerRef,
  flyoutHighlightIndex,
  setFlyoutHighlightIndex,
}: UseKeyboardOptions): void {
  const hasMovedFlyoutHighlightRef = useRef(false);

  useEffect(() => {
    hasMovedFlyoutHighlightRef.current = false;
  }, [openFlyout]);

  const selectAtIndex = useCallback(
    (idx: number) => {
      for (const entry of entries) {
        if (entry.kind === "image" && entry.flatIndex === idx) {
          onImageUpload?.();
          onClose();
          return;
        }
        if (entry.kind === "mode" && entry.flatIndex === idx) {
          onModeSelect(entry.mode.id);
          return;
        }
        if (entry.kind === "item" && entry.flatIndex === idx) {
          onSelect(entry.item);
          return;
        }
        if (entry.kind === "flyout" && entry.flatIndex === idx) {
          const itemEls =
            listRef.current?.querySelectorAll("[data-slash-flat]");
          const el = itemEls?.[idx] as HTMLElement | undefined;
          if (el) {
            setOpenFlyout({
              kind: "category",
              category: entry.category,
              anchorTop: el.getBoundingClientRect().top,
              items: entry.items,
            });
          }
          return;
        }
      }
    },
    [
      entries,
      onImageUpload,
      onModeSelect,
      onSelect,
      setOpenFlyout,
      listRef,
      onClose,
    ]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!visible) return false;

      // When a flyout is open, delegate navigation + selection to it.
      if (openFlyout?.kind === "category" && openFlyout.items) {
        const flyoutItems = openFlyout.items;
        const flyoutTotal = flyoutItems.length;

        if (event.key === "Escape") {
          setOpenFlyout(null);
          return true;
        }
        if (event.key === "ArrowDown") {
          setKeyboardNavigated(true);
          if (hasMovedFlyoutHighlightRef.current) {
            setFlyoutHighlightIndex(
              flyoutHighlightIndex < flyoutTotal - 1
                ? flyoutHighlightIndex + 1
                : 0
            );
          }
          hasMovedFlyoutHighlightRef.current = true;
          return true;
        }
        if (event.key === "ArrowUp") {
          setKeyboardNavigated(true);
          hasMovedFlyoutHighlightRef.current = true;
          setFlyoutHighlightIndex(
            flyoutHighlightIndex > 0
              ? flyoutHighlightIndex - 1
              : flyoutTotal - 1
          );
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = flyoutItems[flyoutHighlightIndex];
          if (item) onSelect(item);
          return true;
        }
        return false;
      }
      if (openFlyout && event.key === "Escape") {
        setOpenFlyout(null);
        return true;
      }

      switch (event.key) {
        case "ArrowDown":
          setKeyboardNavigated(true);
          setHighlightIndex(
            highlightIndex < totalFlat - 1 ? highlightIndex + 1 : 0
          );
          return true;
        case "ArrowUp":
          setKeyboardNavigated(true);
          setHighlightIndex(
            highlightIndex > 0 ? highlightIndex - 1 : totalFlat - 1
          );
          return true;
        case "Enter":
        case "Tab":
          selectAtIndex(highlightIndex);
          return true;
        case "Escape":
          onClose();
          return true;
        default:
          return false;
      }
    },
    [
      visible,
      openFlyout,
      totalFlat,
      highlightIndex,
      flyoutHighlightIndex,
      selectAtIndex,
      setHighlightIndex,
      setKeyboardNavigated,
      setOpenFlyout,
      setFlyoutHighlightIndex,
      onSelect,
      onClose,
    ]
  );

  useEffect(() => {
    keyboardHandlerRef.current = handleKeyDown;
  }, [handleKeyDown, keyboardHandlerRef]);
}
