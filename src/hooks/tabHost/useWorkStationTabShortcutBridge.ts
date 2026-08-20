/**
 * Bridges global Cmd+T / Cmd+W (dispatched as custom events from useTabShortcuts)
 * into the active Workstation app. Only the mounted tool should register handlers.
 *
 * `onNewTab` is optional — the Code Editor intentionally does not register
 * a handler for ⌘T because file lookup is owned by ⌘P (file palette).
 * Hosts that have a meaningful "new tab" concept (Browser: new browser
 * session, Database: add connection, Project: new project) keep their
 * `onNewTab` wiring.
 */
import { useEffect } from "react";

export interface WorkStationTabShortcutBridgeOptions {
  enabled: boolean;
  onNewTab?: () => void;
  onCloseActiveTab: () => void;
}

const HUMANTOOLS_NEW_TAB = "workstation-new-tab";
const HUMANTOOLS_CLOSE_ACTIVE_TAB = "workstation-close-active-tab";

export function useWorkStationTabShortcutBridge(
  options: WorkStationTabShortcutBridgeOptions
): void {
  const { enabled, onNewTab, onCloseActiveTab } = options;

  useEffect(() => {
    if (!enabled) return;

    const handleClose = () => {
      onCloseActiveTab();
    };
    window.addEventListener(HUMANTOOLS_CLOSE_ACTIVE_TAB, handleClose);

    let detachNew: (() => void) | undefined;
    if (onNewTab) {
      const handleNew = () => {
        onNewTab();
      };
      window.addEventListener(HUMANTOOLS_NEW_TAB, handleNew);
      detachNew = () => {
        window.removeEventListener(HUMANTOOLS_NEW_TAB, handleNew);
      };
    }

    return () => {
      window.removeEventListener(HUMANTOOLS_CLOSE_ACTIVE_TAB, handleClose);
      detachNew?.();
    };
  }, [enabled, onNewTab, onCloseActiveTab]);
}
