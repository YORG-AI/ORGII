// ============================================
// useAPICallPanelProvider Hook
// ============================================
/**
 * useAPICallPanelProvider Hook
 *
 * Handles provider-level logic for Panel API Call:
 * - Panel visibility state
 * - API calls tracking
 * - Event listeners for keyboard shortcuts
 * - Polling for updates when panel is visible
 *
 * @example
 * const { visible, apiCalls, handleClose, handleClear } = useAPICallPanelProvider();
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { startVisibilityAwarePoller } from "@src/shared/scheduling/visibilityAwarePoller";
import {
  clearApiCalls,
  disableApiTracking,
  enableApiTracking,
  getApiCallHotspots,
  getApiCalls,
  getPushHotspots,
  getTimerHotspots,
} from "@src/util/monitoring/apiTracker";
import type {
  ApiCall,
  ApiCallHotspot,
  PushHotspot,
  TimerHotspot,
} from "@src/util/monitoring/apiTracker";

// ============================================
// Type Definitions
// ============================================

export interface UseAPICallPanelProviderReturn {
  visible: boolean;
  apiCalls: ApiCall[];
  hotspots: ApiCallHotspot[];
  timerHotspots: TimerHotspot[];
  pushHotspots: PushHotspot[];
  handleClose: () => void;
  handleClear: () => void;
}

// ============================================
// Hook Implementation
// ============================================

export function useAPICallPanelProvider(): UseAPICallPanelProviderReturn {
  // State
  const [visible, setVisible] = useState(false);
  const [apiCalls, setApiCalls] = useState<ApiCall[]>([]);
  const [hotspots, setHotspots] = useState<ApiCallHotspot[]>([]);
  const [timerHotspots, setTimerHotspots] = useState<TimerHotspot[]>([]);
  const [pushHotspots, setPushHotspots] = useState<PushHotspot[]>([]);

  // Avoid updating panel state unless the panel is actually visible.
  // Without this, devtools tracking can cause heavy re-render work (and even visible UI "flash")
  // during normal app usage.
  const visibleRef = useRef<boolean>(visible);

  // Update ref in effect to avoid updating during render
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const isPanelForeground = useCallback(
    () =>
      typeof document === "undefined" ||
      (!document.hidden && document.hasFocus()),
    []
  );

  // ============================================
  // Methods
  // ============================================

  /**
   * Update API calls list
   */
  const updateApiCalls = useCallback(() => {
    if (!visibleRef.current || !isPanelForeground()) return;
    const calls = getApiCalls();
    setApiCalls(calls);
    setHotspots(getApiCallHotspots());
    setTimerHotspots(getTimerHotspots());
    setPushHotspots(getPushHotspots());
  }, [isPanelForeground]);

  const resetPanelData = useCallback(() => {
    clearApiCalls();
    setApiCalls([]);
    setHotspots([]);
    setTimerHotspots([]);
    setPushHotspots([]);
  }, []);

  const openPanel = useCallback(() => {
    resetPanelData();
    enableApiTracking();
    visibleRef.current = true;
    setVisible(true);
  }, [resetPanelData]);

  const closePanel = useCallback(() => {
    visibleRef.current = false;
    setVisible(false);
    disableApiTracking();
    resetPanelData();
  }, [resetPanelData]);

  /**
   * Toggle panel visibility
   */
  const togglePanel = useCallback(() => {
    if (visibleRef.current) {
      closePanel();
      return;
    }
    openPanel();
  }, [closePanel, openPanel]);

  /**
   * Handle clear all operations
   */
  const handleClear = useCallback(() => {
    resetPanelData();
  }, [resetPanelData]);

  /**
   * Handle close panel
   */
  const handleClose = useCallback(() => {
    closePanel();
  }, [closePanel]);

  // ============================================
  // Effects
  // ============================================

  // Initialize event listeners
  useEffect(() => {
    // Listen for toggle event
    const handleToggle = () => {
      togglePanel();
    };

    // Listen for API call updates when panel is visible
    const handleApiCallUpdated = () => {
      if (!visibleRef.current || !isPanelForeground()) return;
      updateApiCalls();
    };

    window.addEventListener("toggle-panel-api-call", handleToggle);
    window.addEventListener("api-call-updated", handleApiCallUpdated);
    return () => {
      window.removeEventListener("toggle-panel-api-call", handleToggle);
      window.removeEventListener("api-call-updated", handleApiCallUpdated);
      visibleRef.current = false;
      disableApiTracking();
      clearApiCalls();
    };
  }, [isPanelForeground, togglePanel, updateApiCalls]);

  // Update calls when becoming visible
  useEffect(() => {
    if (!visible || typeof document === "undefined") return;

    return startVisibilityAwarePoller(
      document,
      async () => updateApiCalls(),
      1000,
      {
        pauseWhenUnfocused: true,
        focusSource: window,
      }
    );
  }, [visible, updateApiCalls]);

  return {
    visible,
    apiCalls,
    hotspots,
    timerHotspots,
    pushHotspots,
    handleClose,
    handleClear,
  };
}
