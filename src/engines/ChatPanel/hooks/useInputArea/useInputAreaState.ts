/**
 * useInputAreaState
 *
 * Manages local state for the InputArea component
 */
import { useState } from "react";

import { useExclusiveComposerMenuState } from "@src/hooks/input/useExclusiveComposerMenuState";

import type { InputAreaState } from "./types";

export function useInputAreaState(): InputAreaState {
  const [isInputFocused, setIsInputFocused] = useState(false);

  const {
    showContextMenu,
    setShowContextMenu,
    showSlashMenu,
    setShowSlashMenu,
  } = useExclusiveComposerMenuState();

  // @ Mention query
  const [atSearchQuery, setAtSearchQuery] = useState("");

  // Slash command query
  const [slashQuery, setSlashQuery] = useState("");

  return {
    // Input focus
    isInputFocused,
    setIsInputFocused,

    // @ Mention
    showContextMenu,
    setShowContextMenu,
    atSearchQuery,
    setAtSearchQuery,

    // Slash command
    showSlashMenu,
    setShowSlashMenu,
    slashQuery,
    setSlashQuery,
  };
}
