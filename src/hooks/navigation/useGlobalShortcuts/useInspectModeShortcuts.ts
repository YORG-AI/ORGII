import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";

import {
  inspectModeEnabledAtom,
  inspectModeLockedAtom,
} from "@src/store/ui/uiAtom";

/**
 * Inspect mode shortcut handlers (Cmd+8, Cmd+9, Tab/Shift+Tab, H, X)
 */
export function useInspectModeShortcuts() {
  const _setInspectModeLocked = useSetAtom(inspectModeLockedAtom);
  const [inspectModeEnabled, setInspectModeEnabled] = useAtom(
    inspectModeEnabledAtom
  );

  // Use ref to track inspect mode without causing listener re-registration
  const inspectModeRef = useRef(inspectModeEnabled);
  useEffect(() => {
    inspectModeRef.current = inspectModeEnabled;
  }, [inspectModeEnabled]);

  // Handle Command+8 - Toggle inspect element mode
  const handleToggleInspectMode = useCallback(async () => {
    const { isInspectModeEnabled, enableInspectMode, disableInspectMode } =
      await import("@src/util/core/error/componentIssueTracker/");
    const wasEnabled = isInspectModeEnabled();

    if (wasEnabled) {
      disableInspectMode();
      setInspectModeEnabled(false);
    } else {
      enableInspectMode();
      setInspectModeEnabled(true);
    }
  }, [setInspectModeEnabled]);

  // Handle Tab in inspect mode - Move up level in DOM hierarchy
  const handleInspectMoveUpLevel = useCallback(async () => {
    const { isInspectModeEnabled, moveUpLevel } =
      await import("@src/util/core/error/componentIssueTracker/");

    if (!isInspectModeEnabled()) return false;

    return moveUpLevel();
  }, []);

  // Handle Shift+Tab in inspect mode - Move down level in DOM hierarchy
  const handleInspectMoveDownLevel = useCallback(async () => {
    const { isInspectModeEnabled, moveDownLevel } =
      await import("@src/util/core/error/componentIssueTracker/");

    if (!isInspectModeEnabled()) return false;

    return moveDownLevel();
  }, []);

  // Handle H in inspect mode - Toggle label visibility
  const handleInspectToggleLabels = useCallback(async () => {
    const { isInspectModeEnabled, toggleLabelsHidden } =
      await import("@src/util/core/error/componentIssueTracker/");

    if (!isInspectModeEnabled()) return false;

    toggleLabelsHidden();
    return true;
  }, []);

  // Handle X in inspect mode - Hide labels (without toggle)
  const handleInspectHideLabels = useCallback(async () => {
    const { isInspectModeEnabled, hideLabels } =
      await import("@src/util/core/error/componentIssueTracker/");

    if (!isInspectModeEnabled()) return false;

    hideLabels();
    return true;
  }, []);

  // Handle Command+9 - Show component issue modal for hovered element
  const handleShowComponentIssue = useCallback(async () => {
    const { disableInspectMode, getEffectiveElement } =
      await import("@src/util/core/error/componentIssueTracker/");
    const targetElement = getEffectiveElement();

    disableInspectMode();
    setInspectModeEnabled(false);

    window.dispatchEvent(
      new CustomEvent("show-component-issue", {
        detail: { element: targetElement },
      })
    );
  }, [setInspectModeEnabled]);

  return {
    inspectModeRef,
    handleToggleInspectMode,
    handleInspectMoveUpLevel,
    handleInspectMoveDownLevel,
    handleInspectToggleLabels,
    handleInspectHideLabels,
    handleShowComponentIssue,
  };
}
