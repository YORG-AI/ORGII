/**
 * useInputAreaRefs
 *
 * Manages all refs for the InputArea component
 */
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useRef,
} from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";

import type { InputAreaRefs } from "./types";

export function useInputAreaRefs(): InputAreaRefs {
  const composerInputRef = useRef<ComposerInputRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hasContentRef = useRef(false);
  const contextMenuKeyboardHandlerRef = useRef<
    ((event: ReactKeyboardEvent) => boolean) | null
  >(null);
  const slashCommandKeyboardHandlerRef = useRef<
    ((event: globalThis.KeyboardEvent) => boolean) | null
  >(null);

  // Setter function to update hasContentRef (avoids React Compiler immutability issues)
  const setHasContent = useCallback((value: boolean) => {
    hasContentRef.current = value;
  }, []);

  return {
    composerInputRef,
    containerRef,
    contextMenuKeyboardHandlerRef,
    slashCommandKeyboardHandlerRef,
    hasContentRef,
    setHasContent,
  };
}
