/**
 * useJumpToSimulatorCanvas — navigate the Simulator to the Canvas view.
 *
 * Calls `openInSimulatorCanvas` to store the payload in `canvasPreviewAtom`,
 * opens Agent Station, and switches the simulator dock to the canvas app.
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { replayModeAtom } from "@src/engines/SessionCore";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import {
  STATION_MODE,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";

import { openInSimulatorCanvas } from "./openInSimulatorCanvas";
import type { CanvasInlinePayload } from "./useCanvasInlineStream";

export function useJumpToSimulatorCanvas(
  sessionId: string | null | undefined,
  payload: CanvasInlinePayload | null | undefined
): (() => void) | null {
  const setSelectedApp = useSetAtom(simulatorSelectedAppAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setReplayMode = useSetAtom(replayModeAtom);
  const navigate = useNavigate();

  const jump = useCallback(() => {
    if (!sessionId || !payload) return;
    openInSimulatorCanvas(sessionId, payload);
    setStationMode(STATION_MODE.AGENT_STATION);
    setSelectedApp(AppType.CANVAS);
    setReplayMode("replay");
    navigate(ROUTES.workStation.chat.path);
  }, [
    sessionId,
    payload,
    setStationMode,
    setSelectedApp,
    setReplayMode,
    navigate,
  ]);

  if (!sessionId || !payload) return null;
  return jump;
}
