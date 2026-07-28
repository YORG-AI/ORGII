/**
 * Shared helper functions for session launch.
 */
import type { NavigateFunction } from "react-router-dom";

import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import type { StationMode } from "@src/store/ui/simulatorAtom";

import type { SessionLaunchSuccessInfo } from "./types";

export { createSyntheticUserEvent } from "@src/engines/SessionCore/sync/adapters/shared";

// ============================================
// Navigation
// ============================================

export interface SessionNavigationParams {
  sessionId: string;
  locationPathname: string;
  navigate: NavigateFunction;
  /** Pipeline atom setter — drives the live event subscription. */
  setActiveSessionId: (id: string) => void;
  /** WorkStation memory setter — what WorkStation re-asserts on focus. */
  setWorkstationActiveSessionId: (id: string) => void;
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
    clearDraft,
    setStationMode,
    forceNavigate,
    onLaunchSuccess,
  } = params;

  const stayInPlace = !forceNavigate && isWorkbenchPath(locationPathname);

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
    setWorkstationActiveSessionId(sessionId);
    setActiveSessionId(sessionId);
    navigate(ROUTES.workStation.base.path);
    clearDraft(null);
  }

  onLaunchSuccess?.({ sessionId });
}
