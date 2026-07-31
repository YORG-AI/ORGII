import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";

import { useRouteAppMode } from "@src/config/routeViewModeConfig";
import { replayModeAtom } from "@src/engines/SessionCore";
import {
  type StationMode,
  simulatorSessionPlaybackPlayingAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";
import {
  opsControlFocusedTabAtom,
  opsControlPeekHostAtom,
} from "@src/store/workstation";

interface AppShellStationModeState {
  stationMode: StationMode;
  isAgentStation: boolean;
  isOpsControlStation: boolean;
  isJourneyStation: boolean;
  opsControlPeekHost: "code" | "browser" | "data" | "project" | null;
  hasVisitedAgentStation: boolean;
  illuminateAgentStationChrome: boolean;
}

export function useAppShellStationMode({
  followAgentHighlightEnabled,
}: {
  followAgentHighlightEnabled: boolean;
}): AppShellStationModeState {
  const appMode = useRouteAppMode();
  const stationMode = useAtomValue(stationModeAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const opsControlPeekHost = useAtomValue(opsControlPeekHostAtom);
  const setOpsControlPeekHost = useSetAtom(opsControlPeekHostAtom);
  const setOpsControlFocusedTab = useSetAtom(opsControlFocusedTabAtom);
  const isAgentStation = stationMode === "agent-station";
  const isOpsControlStation = stationMode === "ops-control";
  const isJourneyStation = stationMode === "journey";
  const replayMode = useAtomValue(replayModeAtom);
  const sessionPlaybackPlaying = useAtomValue(
    simulatorSessionPlaybackPlayingAtom
  );

  const stationModeRef = useRef(stationMode);
  useEffect(() => {
    stationModeRef.current = stationMode;
  }, [stationMode]);

  useEffect(() => {
    if (appMode === "opsControl") {
      if (stationModeRef.current !== "ops-control") {
        setStationMode("ops-control");
      }
      return;
    }
    if (appMode === "journey") {
      if (stationModeRef.current !== "journey") {
        setStationMode("journey");
      }
      return;
    }
    if (
      stationModeRef.current === "ops-control" ||
      stationModeRef.current === "journey"
    ) {
      setStationMode("my-station");
    }
  }, [appMode, setStationMode]);

  useEffect(() => {
    if (isOpsControlStation || opsControlPeekHost === null) return;
    setOpsControlPeekHost(null);
    setOpsControlFocusedTab(null);
  }, [
    isOpsControlStation,
    opsControlPeekHost,
    setOpsControlFocusedTab,
    setOpsControlPeekHost,
  ]);

  const [hasVisitedAgentStation, setHasVisitedAgentStation] = useState(
    () => isAgentStation
  );
  useEffect(() => {
    if (isAgentStation && !hasVisitedAgentStation) {
      const handle = requestAnimationFrame(() => {
        setHasVisitedAgentStation(true);
      });
      return () => cancelAnimationFrame(handle);
    }
  }, [isAgentStation, hasVisitedAgentStation]);

  const showAgentStationChrome = followAgentHighlightEnabled && isAgentStation;
  const illuminateAgentStationChrome =
    showAgentStationChrome &&
    (replayMode === "follow" ||
      (replayMode === "replay" && sessionPlaybackPlaying));

  return {
    stationMode,
    isAgentStation,
    isOpsControlStation,
    isJourneyStation,
    opsControlPeekHost,
    hasVisitedAgentStation,
    illuminateAgentStationChrome,
  };
}
