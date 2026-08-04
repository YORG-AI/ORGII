import { useEffect } from "react";

import {
  finishSessionSwitchTrace,
  hasActiveSessionSwitchTrace,
} from "./sessionSwitchPerformance";

/**
 * Finish a session-switch trace after React has committed loaded state and the
 * browser has crossed two animation frames, making the measure a useful proxy
 * for click-to-paint instead of merely click-to-state-update.
 */
export function useSessionSwitchPaintTrace(
  sessionId: string,
  loaded: boolean
): void {
  useEffect(() => {
    if (!loaded || !hasActiveSessionSwitchTrace(sessionId)) return;
    if (
      typeof requestAnimationFrame !== "function" ||
      typeof cancelAnimationFrame !== "function"
    ) {
      return;
    }

    let paintFrame = 0;
    const commitFrame = requestAnimationFrame(() => {
      paintFrame = requestAnimationFrame(() => {
        finishSessionSwitchTrace(sessionId, "painted");
      });
    });

    return () => {
      cancelAnimationFrame(commitFrame);
      if (paintFrame !== 0) cancelAnimationFrame(paintFrame);
    };
  }, [loaded, sessionId]);
}
