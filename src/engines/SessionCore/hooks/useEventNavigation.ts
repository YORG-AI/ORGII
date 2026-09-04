/**
 * useEventNavigation Hook
 *
 * Routes event navigation through the Agent Station and the canonical
 * SessionCore navigation atoms.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import {
  goLiveAtom,
  navigateNextAtom,
  navigatePrevAtom,
  navigateToEventAtom,
} from "../core/atoms";

/**
 * Hook for event navigation only.
 * Use in replay controls, chat event clicks, etc.
 */
export function useEventNavigation() {
  const navigate = useNavigate();
  const stationMode = useAtomValue(stationModeAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const navigateToEventAtomSetter = useSetAtom(navigateToEventAtom);
  const navigateNext = useSetAtom(navigateNextAtom);
  const navigatePrev = useSetAtom(navigatePrevAtom);
  const goLive = useSetAtom(goLiveAtom);

  const navigateToEvent = useCallback(
    (eventId: string) => {
      if (!isWorkbenchPath(window.location.pathname)) {
        navigate(ROUTES.workStation.base.path);
      }
      if (stationMode !== "agent-station") {
        setStationMode("agent-station");
      }
      navigateToEventAtomSetter(eventId);
    },
    [navigate, navigateToEventAtomSetter, setStationMode, stationMode]
  );

  return useMemo(
    () => ({
      navigateToEvent,
      navigateNext,
      navigatePrev,
      goLive,
    }),
    [navigateToEvent, navigateNext, navigatePrev, goLive]
  );
}
