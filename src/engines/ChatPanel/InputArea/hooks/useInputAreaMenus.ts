import { type RefObject, useCallback } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";

const TERMINAL_SNAPSHOT_REQUEST_EVENT = "terminal-snapshot-request";

interface UseInputAreaMenusOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  setShowContextMenu: (show: boolean) => void;
  setAtSearchQuery: (query: string) => void;
  handleAtMention: (query: string, position: { x: number; y: number }) => void;
}

export function useInputAreaMenus({
  composerInputRef,
  setShowContextMenu,
  setAtSearchQuery,
  handleAtMention,
}: UseInputAreaMenusOptions) {
  const handleOpenContextMenu = useCallback(() => {
    window.dispatchEvent(new Event(TERMINAL_SNAPSHOT_REQUEST_EVENT));
    composerInputRef.current?.triggerAtMention();
  }, [composerInputRef]);

  const handleContextMenuClose = useCallback(() => {
    setShowContextMenu(false);
    setAtSearchQuery("");
  }, [setShowContextMenu, setAtSearchQuery]);

  const handleKeyboardAtMention = useCallback(
    (query: string, position: { x: number; y: number }) => {
      window.dispatchEvent(new Event(TERMINAL_SNAPSHOT_REQUEST_EVENT));
      handleAtMention(query, position);
    },
    [handleAtMention]
  );

  return {
    handleOpenContextMenu,
    handleContextMenuClose,
    handleKeyboardAtMention,
  };
}
