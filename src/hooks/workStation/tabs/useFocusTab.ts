import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  type TabFocusRequest,
  focusTabAtom,
} from "@src/store/workstation/tabRegistry";

/**
 * Focus a tab inside the unified workstation pane registry. The unified pane
 * tree owns focus, and the visible content host follows the active tab
 * (`activeHostAtom`), so focusing a tab is all that is needed to swap the
 * content area — no host pin to release.
 */
export function useFocusTab(): (request: TabFocusRequest) => void {
  const setStationMode = useSetAtom(stationModeAtom);
  const focusTab = useSetAtom(focusTabAtom);

  return useCallback(
    (request: TabFocusRequest) => {
      setStationMode("my-station");
      focusTab(request);
    },
    [setStationMode, focusTab]
  );
}
