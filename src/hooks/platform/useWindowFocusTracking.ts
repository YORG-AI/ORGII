/**
 * Window Focus Tracking Hook
 *
 * Tracks window focus/blur events and notifies the backend for adaptive git polling.
 *
 * Polling frequency adjusts based on focus:
 * - Focused + recent changes: 3s (fast - reduced from 1.5s to prevent fd exhaustion)
 * - Focused + no changes: 5s (moderate)
 * - Not focused: 15s (slow)
 * - Idle 5+ min: 30s (very slow)
 *
 * Note: Each git status spawns 4-6 processes, so conservative intervals prevent
 * "Bad file descriptor" errors from too many concurrent git operations.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("WindowFocus");

interface FocusDocument {
  readonly hidden: boolean;
  hasFocus(): boolean;
  readonly documentElement: {
    readonly dataset: DOMStringMap;
  };
}

/**
 * Mirror native-window focus onto the document so global CSS can suspend
 * compositor animations while this desktop window is not interactive.
 */
export function reflectWindowFocusState(
  focusDocument: FocusDocument = document
): boolean {
  const focused = focusDocument.hasFocus() && !focusDocument.hidden;
  focusDocument.documentElement.dataset.windowFocused = String(focused);
  return focused;
}

export function useWindowFocusTracking() {
  useEffect(() => {
    let lastReportedFocus: boolean | null = null;
    async function syncFocusState() {
      const focused = reflectWindowFocusState();
      if (focused === lastReportedFocus) return;
      lastReportedFocus = focused;
      try {
        await invoke("set_window_focus", { focused });
      } catch (error) {
        log.error("[WindowFocus] Failed to set focused state:", error);
      }
    }

    // Track window focus/blur
    window.addEventListener("focus", syncFocusState);
    window.addEventListener("blur", syncFocusState);
    document.addEventListener("visibilitychange", syncFocusState);

    void syncFocusState();

    return () => {
      window.removeEventListener("focus", syncFocusState);
      window.removeEventListener("blur", syncFocusState);
      document.removeEventListener("visibilitychange", syncFocusState);
    };
  }, []);
}
