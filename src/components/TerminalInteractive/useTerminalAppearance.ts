import type { Terminal } from "@xterm/xterm";
import { type RefObject, useEffect } from "react";

// Direct leaf import to avoid pulling @src/store's barrel — which transitively
// reaches SidebarModules/Terminal → engines/TerminalCore → this file.
import { createLogger } from "@src/hooks/logger";
import type { TerminalThemeName } from "@src/store/ui/uiAtom";

import { getXTermTheme } from "./utils";

const log = createLogger("Terminal");

/**
 * Appearance updates can outlive their xterm instance (font readiness,
 * animation frames, and resize timers all cross React cleanup boundaries).
 * Never touch a replaced/disposed renderer, and keep a renderer-level race
 * from escaping into the application error boundary.
 */
export function runForLiveTerminal(
  terminalRef: RefObject<Terminal | null>,
  terminal: Terminal,
  operation: () => void
): boolean {
  if (terminalRef.current !== terminal) return false;
  try {
    operation();
    return true;
  } catch (error) {
    log.warn("[Terminal] appearance update skipped:", error);
    return false;
  }
}

interface UseTerminalAppearanceOptions {
  terminalRef: RefObject<Terminal | null>;
  fitTerminal: () => void;
  isReady: boolean;
  terminalTheme: TerminalThemeName;
  isDarkTheme: boolean;
  terminalFontSize: number;
  terminalLetterSpacing: number;
  codeFontFamily: string;
  backgroundColor?: string;
}

export function useTerminalAppearance({
  terminalRef,
  fitTerminal,
  isReady,
  terminalTheme,
  isDarkTheme,
  terminalFontSize,
  terminalLetterSpacing,
  codeFontFamily,
  backgroundColor,
}: UseTerminalAppearanceOptions): void {
  // Handle theme changes (both terminal theme and app theme).
  // Patches the live xterm instance — same approach as VSCode: swap the
  // theme, drop the WebGL glyph atlas (which cached bitmaps with the old
  // foreground colour), then refresh visible rows.
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;

    let frameId: number | null = null;
    if (
      runForLiveTerminal(terminalRef, terminal, () => {
        terminal.options.theme = getXTermTheme(terminalTheme, backgroundColor);
        terminal.options.cursorStyle = "bar";
        terminal.options.cursorBlink = true;
        terminal.options.cursorInactiveStyle = "outline";
        terminal.clearTextureAtlas();
        terminal.refresh(0, terminal.rows - 1);
      })
    ) {
      frameId = requestAnimationFrame(() => {
        if (terminalRef.current === terminal) fitTerminal();
      });
    }

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [
    terminalTheme,
    backgroundColor,
    isDarkTheme,
    isReady,
    fitTerminal,
    terminalRef,
  ]);

  // Handle font size changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;
    if (
      !runForLiveTerminal(terminalRef, terminal, () => {
        terminal.options.fontSize = terminalFontSize;
        terminal.clearTextureAtlas();
      })
    ) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (terminalRef.current === terminal) fitTerminal();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [terminalFontSize, isReady, fitTerminal, terminalRef]);

  // Handle letter spacing (character gap) changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;
    if (
      !runForLiveTerminal(terminalRef, terminal, () => {
        terminal.options.letterSpacing = terminalLetterSpacing;
        terminal.clearTextureAtlas();
      })
    ) {
      return;
    }
    const timeoutId = setTimeout(() => {
      if (terminalRef.current === terminal) fitTerminal();
    }, 50);
    return () => clearTimeout(timeoutId);
  }, [terminalLetterSpacing, isReady, fitTerminal, terminalRef]);

  // Handle font family changes
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !isReady) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const applyFont = () => {
      if (cancelled) return;
      if (
        !runForLiveTerminal(terminalRef, terminal, () => {
          terminal.options.fontFamily = codeFontFamily;
          // Clear the WebGL glyph texture atlas so it is rebuilt with the new
          // font. Without this xterm re-uses cached glyph bitmaps measured
          // against the old font, producing misaligned characters.
          terminal.clearTextureAtlas();
        })
      ) {
        return;
      }
      timeoutId = setTimeout(() => {
        if (!cancelled && terminalRef.current === terminal) fitTerminal();
      }, 50);
    };

    if (typeof document.fonts?.ready === "undefined") {
      applyFont();
    } else {
      void document.fonts.ready.then(applyFont);
    }

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [codeFontFamily, isReady, fitTerminal, terminalRef]);
}
