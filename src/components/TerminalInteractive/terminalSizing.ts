import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("Terminal");

interface TerminalSizingRefs {
  containerRef: MutableRefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
}

export function createRedrawTerminalAfterLayoutChange({
  containerRef,
  terminalRef,
  fitAddonRef,
}: TerminalSizingRefs) {
  return () => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    const container = containerRef.current;
    if (!terminal || !fitAddon || !container) return;

    requestAnimationFrame(() => {
      // A replacement terminal can mount before this frame runs. Checking
      // merely for non-null refs would then operate on the disposed instance
      // captured above while a different live instance occupies the refs.
      if (
        terminalRef.current !== terminal ||
        fitAddonRef.current !== fitAddon ||
        containerRef.current !== container
      ) {
        return;
      }
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      try {
        terminal.clearTextureAtlas();
        fitAddon.fit();
        terminal.refresh(0, terminal.rows - 1);
      } catch (error) {
        log.warn("[Terminal] redraw after layout change failed:", error);
      }
    });
  };
}

export function createFitTerminal({
  containerRef,
  terminalRef,
  fitAddonRef,
}: TerminalSizingRefs) {
  const fitTerminal = (retryCount = 0) => {
    if (fitAddonRef.current && terminalRef.current && containerRef.current) {
      try {
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          if (retryCount < 5) {
            setTimeout(
              () => fitTerminal(retryCount + 1),
              100 * Math.pow(2, retryCount)
            );
          }
          return;
        }

        terminalRef.current.clearTextureAtlas();
        fitAddonRef.current.fit();
        terminalRef.current.refresh(0, terminalRef.current.rows - 1);
      } catch (error) {
        log.warn("[Terminal] Fit error:", error);
      }
    }
  };

  return fitTerminal;
}
