/**
 * useFollowAgent
 *
 * Determines whether the "Follow Agent" button should be shown
 * (my-station mode) and provides the click handler
 * that flips into agent-station + follow replay mode.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { replayModeAtom } from "@src/engines/SessionCore";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";

const AGENT_STATION_SHORTCUT_ID = "open_agent_station";

export interface UseFollowAgentReturn {
  showFollowAgent: boolean;
  followAgentLabel: string;
  followAgentTooltipLabel: string;
  followAgentShortcut: string;
  handleFollowAgent: () => void;
}

export function useFollowAgent(): UseFollowAgentReturn {
  const { t } = useTranslation(["sessions", "common"]);
  const stationMode = useAtomValue(stationModeAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setReplayMode = useSetAtom(replayModeAtom);

  const showFollowAgent = stationMode === STATION_MODE.MY_STATION;
  const agentStationLabel = t("common:terminology.agentStation");

  const handleFollowAgent = useCallback(() => {
    setStationMode(STATION_MODE.AGENT_STATION);
    setReplayMode("follow");
  }, [setStationMode, setReplayMode]);

  return {
    showFollowAgent,
    followAgentLabel: t("chat.replay.follow"),
    followAgentTooltipLabel: t("common:actions.switchToStation", {
      station: agentStationLabel,
    }),
    followAgentShortcut: getShortcutKeys(AGENT_STATION_SHORTCUT_ID),
    handleFollowAgent,
  };
}
