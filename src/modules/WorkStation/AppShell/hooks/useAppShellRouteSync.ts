import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  restoreChatWidthAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";

/**
 * Load-bearing side effects for landing on the bare workstation base path
 * (`/orgii/workstation`): snap into My Station, restore the station's chat
 * visibility, and restore the chat width. The visible content host follows
 * the active tab (`activeHostAtom`), so there is no route → host state to
 * sync — this hook is purely about the base-path entry side effects.
 */
export function useAppShellRouteSync(): void {
  const restoreChatWidth = useSetAtom(restoreChatWidthAtom);
  const setStationChatVisibility = useSetAtom(stationChatVisibilityAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const location = useLocation();
  const isWorkstationBasePath =
    location.pathname === ROUTES.workStation.base.path;

  useEffect(() => {
    if (!isWorkstationBasePath) return;
    setStationMode(STATION_MODE.MY_STATION);
    setStationChatVisibility((prev) => ({
      ...prev,
      [STATION_MODE.MY_STATION]: true,
    }));
    restoreChatWidth();
  }, [
    isWorkstationBasePath,
    restoreChatWidth,
    setStationChatVisibility,
    setStationMode,
  ]);
}
