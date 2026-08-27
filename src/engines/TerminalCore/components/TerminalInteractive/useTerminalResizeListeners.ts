import type { Terminal } from "@xterm/xterm";
import { type RefObject, useEffect } from "react";

interface UseTerminalResizeListenersOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  fitTerminal: () => void;
  redrawTerminalAfterLayoutChange: () => void;
  isReady: boolean;
  terminalRef: RefObject<Terminal | null>;
}

export function useTerminalResizeListeners({
  containerRef,
  fitTerminal,
  redrawTerminalAfterLayoutChange,
  isReady,
  terminalRef,
}: UseTerminalResizeListenersOptions): void {
  // Handle window resize
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fitTerminal, 100);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (timer !== null) clearTimeout(timer);
    };
  }, [fitTerminal]);

  // Handle container resize (panel drag, split-pane, etc.).
  // A single trailing-edge debounce at 100 ms prevents a fit storm during
  // drag resize while still feeling instantaneous to the user.
  useEffect(() => {
    if (!containerRef.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const resizeObserver = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fitTerminal, 100);
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [containerRef, fitTerminal]);

  useEffect(() => {
    if (!isReady) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const handleUiScaleChange = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(redrawTerminalAfterLayoutChange, 50);
    };

    window.addEventListener("uiScaleChange", handleUiScaleChange);
    return () => {
      window.removeEventListener("uiScaleChange", handleUiScaleChange);
      if (timer !== null) clearTimeout(timer);
    };
  }, [isReady, redrawTerminalAfterLayoutChange]);

  // Suppress unused-variable lint — terminalRef is passed for symmetry with
  // useTerminalAppearance but is not needed in resize callbacks.
  void terminalRef;
}
