/**
 * Shared helper functions for session launch.
 */
import type { NavigateFunction } from "react-router-dom";

import { getViewModeForRoute } from "@src/config/routeViewModeConfig";
import { ROUTES } from "@src/config/routes";
import type { StationMode } from "@src/store/ui/simulatorAtom";
import type { ViewModeType } from "@src/store/ui/viewModeAtom";

import type { SessionLaunchSuccessInfo } from "./types";

export { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared";

// ============================================
// Navigation
// ============================================

/**
 * View modes whose session creators are allowed to launch a session
 * "in place" — i.e. without navigating the user back to WorkStation.
 *
 * `workStation` itself is the canonical case. Kanban now lives in
 * Home, so launches from that page use the standard WorkStation navigation.
 *
 * Anything not in this set falls back to the legacy "navigate to
 * WorkStation after launch" behavior.
 */
const STAY_IN_PLACE_VIEW_MODES = new Set<string>(["workStation"]);

export interface SessionNavigationParams {
  sessionId: string;
  locationPathname: string;
  navigate: NavigateFunction;
  /** Pipeline atom setter — drives the live event subscription. */
  setActiveSessionId: (id: string) => void;
  /** WorkStation memory setter — what WorkStation re-asserts on focus. */
  setWorkstationActiveSessionId: (id: string) => void;
  setViewMode: (mode: ViewModeType) => void;
  setIsSwitching: (switching: boolean) => void;
  clearDraft: (draft: null) => void;
  setStationMode: (mode: StationMode) => void;
  forceNavigate?: boolean;
  onLaunchSuccess?: (info: SessionLaunchSuccessInfo) => void;
}

export function handleSessionNavigation(params: SessionNavigationParams): void {
  const {
    sessionId,
    locationPathname,
    navigate,
    setActiveSessionId,
    setWorkstationActiveSessionId,
    setViewMode,
    setIsSwitching,
    clearDraft,
    setStationMode,
    forceNavigate,
    onLaunchSuccess,
  } = params;

  const currentViewMode = getViewModeForRoute(locationPathname);
  const stayInPlace =
    !forceNavigate && STAY_IN_PLACE_VIEW_MODES.has(currentViewMode);

  // Always switch to agent-station so the simulator is visible as soon as
  // the session starts — whether we navigate or stay on the current page.
  setStationMode("agent-station");

  if (stayInPlace) {
    // Surfaces that stay in place still update WorkStation memory so
    // the next time the user navigates to WorkStation, the just-
    // launched session is what they see — but they are NOT yanked
    // there now (e.g. kanban launch keeps the user on the board).
    setWorkstationActiveSessionId(sessionId);
    setActiveSessionId(sessionId);
    clearDraft(null);
  } else {
    setIsSwitching(true);
    setViewMode("workStation");
    setWorkstationActiveSessionId(sessionId);
    setActiveSessionId(sessionId);
    navigate(ROUTES.workStation.base.path);
    clearDraft(null);
    requestAnimationFrame(() => setIsSwitching(false));
  }

  onLaunchSuccess?.({ sessionId });
}
