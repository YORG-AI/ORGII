import { useCallback, useState } from "react";

import {
  getStoredTrailTerminalHeight,
  getStoredTrailTerminalWidth,
  persistTrailTerminalSize,
} from "./railStorage";
import {
  TRAIL_TERMINAL_SIZE_LIMITS,
  type TrailPanelSize,
  clampPanelDimension,
} from "./trailPanelSize";
import { WORKSTATION_TRAIL_TERMINAL_WIDTH } from "./trailWidth";

export function useTrailPanelDimensions() {
  const [terminalWidth, setTerminalWidth] = useState(() => {
    const stored = getStoredTrailTerminalWidth();
    return stored === null
      ? null
      : clampPanelDimension(
          stored,
          TRAIL_TERMINAL_SIZE_LIMITS.minWidth,
          TRAIL_TERMINAL_SIZE_LIMITS.maxWidth
        );
  });
  const [terminalHeight, setTerminalHeight] = useState(() =>
    clampPanelDimension(
      getStoredTrailTerminalHeight() ??
        TRAIL_TERMINAL_SIZE_LIMITS.defaultHeight,
      TRAIL_TERMINAL_SIZE_LIMITS.minHeight,
      TRAIL_TERMINAL_SIZE_LIMITS.maxHeight
    )
  );
  const [isCornerResizing, setIsCornerResizing] = useState(false);

  const resizeTerminal = useCallback((size: TrailPanelSize) => {
    setTerminalWidth(size.width);
    setTerminalHeight(size.height);
  }, []);
  const commitTerminalSize = useCallback((size: TrailPanelSize) => {
    persistTrailTerminalSize(size.width, size.height);
  }, []);

  return {
    terminalWidth: terminalWidth ?? WORKSTATION_TRAIL_TERMINAL_WIDTH,
    terminalHeight,
    isCornerResizing,
    setIsCornerResizing,
    resizeTerminal,
    commitTerminalSize,
  };
}
