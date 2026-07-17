import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";

import { replayModeAtom } from "@src/engines/SessionCore";
import {
  type StationMode,
  simulatorSessionPlaybackPlayingAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";

interface AppShellStationModeState {
  stationMode: StationMode;
  isAgentStation: boolean;
  hasVisitedAgentStation: boolean;
  illuminateAgentStationChrome: boolean;
}

export function useAppShellStationMode({
  followAgentHighlightEnabled,
}: {
  followAgentHighlightEnabled: boolean;
}): AppShellStationModeState {
  const stationMode = useAtomValue(stationModeAtom);
  const isAgentStation = stationMode === "agent-station";
  const replayMode = useAtomValue(replayModeAtom);
  const sessionPlaybackPlaying = useAtomValue(
    simulatorSessionPlaybackPlayingAtom
  );

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
    hasVisitedAgentStation,
    illuminateAgentStationChrome,
  };
}
