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

  // ============================================
  // Methods
  // ============================================

  /**
   * Update API calls list
   */
  const updateApiCalls = useCallback(() => {
    const calls = getApiCalls();
    setApiCalls(calls);
    setHotspots(getApiCallHotspots());
    setTimerHotspots(getTimerHotspots());
    setPushHotspots(getPushHotspots());
  }, []);

  const openPanel = useCallback(() => {
    clearApiCalls();
    setApiCalls([]);
    setHotspots([]);
    setTimerHotspots([]);
    setPushHotspots([]);
    enableApiTracking();
    visibleRef.current = true;
    setVisible(true);
  }, []);

  const closePanel = useCallback(() => {
    disableApiTracking();
    visibleRef.current = false;
    setVisible(false);
  }, []);

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
    clearApiCalls();
    setApiCalls([]);
    setHotspots([]);
    setTimerHotspots([]);
    setPushHotspots([]);
  }, []);

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
      if (!visibleRef.current) return;
      updateApiCalls();
    };

    window.addEventListener("toggle-panel-api-call", handleToggle);
    window.addEventListener("api-call-updated", handleApiCallUpdated);
    return () => {
      window.removeEventListener("toggle-panel-api-call", handleToggle);
      window.removeEventListener("api-call-updated", handleApiCallUpdated);
      disableApiTracking();
    };
  }, [togglePanel, updateApiCalls]);

  // Update calls when becoming visible
  useEffect(() => {
    if (visible) {
      // Schedule state updates asynchronously to avoid synchronous setState in effect
      const timeoutId = setTimeout(() => {
        updateApiCalls();
      }, 0);

      // Keep the visible panel fresh without adding a high-frequency devtools loop.
      const interval = setInterval(() => {
        updateApiCalls();
      }, 1000);

      return () => {
        clearTimeout(timeoutId);
        clearInterval(interval);
      };
    }
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
