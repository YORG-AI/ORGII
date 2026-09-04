import { useCallback, useEffect } from "react";
import type React from "react";

import type { SlashItem } from "@src/types/extensions";

import type { ListEntry } from "./types";

interface UseKeyboardOptions {
  visible: boolean;
  entries: ListEntry[];
  totalFlat: number;
  highlightIndex: number;
  setHighlightIndex: (index: number) => void;
  setKeyboardNavigated: (navigated: boolean) => void;
  onSelect: (item: SlashItem) => void;
  onTogglePin: (item: SlashItem) => void;
  onClose: () => void;
  keyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
}

/** Keyboard navigation for the skills-only `/` menu. */
export function useKeyboard({
  visible,
  entries,
  totalFlat,
  highlightIndex,
  setHighlightIndex,
  setKeyboardNavigated,
  onSelect,
  onTogglePin,
  onClose,
  keyboardHandlerRef,
}: UseKeyboardOptions): void {
  const selectAtIndex = useCallback(
    (index: number) => {
      const entry = entries.find(
        (candidate) =>
          candidate.kind === "item" && candidate.flatIndex === index
      );
      if (entry?.kind === "item") onSelect(entry.item);
    },
    [entries, onSelect]
  );
  const togglePinAtIndex = useCallback(
    (index: number) => {
      const entry = entries.find(
        (candidate) =>
          candidate.kind === "item" && candidate.flatIndex === index
      );
      if (entry?.kind === "item") onTogglePin(entry.item);
    },
    [entries, onTogglePin]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!visible) return false;
      switch (event.key) {
        case "ArrowDown":
          if (totalFlat > 0) {
            setKeyboardNavigated(true);
            setHighlightIndex(
              highlightIndex < totalFlat - 1 ? highlightIndex + 1 : 0
            );
          }
          return true;
        case "ArrowUp":
          if (totalFlat > 0) {
            setKeyboardNavigated(true);
            setHighlightIndex(
              highlightIndex > 0 ? highlightIndex - 1 : totalFlat - 1
            );
          }
          return true;
        case "Enter":
          if (event.shiftKey) {
            togglePinAtIndex(highlightIndex);
          } else {
            selectAtIndex(highlightIndex);
          }
          return true;
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
      highlightIndex,
      onClose,
      selectAtIndex,
      setHighlightIndex,
      setKeyboardNavigated,
      togglePinAtIndex,
      totalFlat,
      visible,
    ]
  );

  useEffect(() => {
    keyboardHandlerRef.current = handleKeyDown;
  }, [handleKeyDown, keyboardHandlerRef]);
}
