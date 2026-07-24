/**
 * useChatViewAgentStationDiff
 *
 * Builds the callback that jumps into Agent Station's Diff app: un-maximizes
 * the chat panel so the simulator pane is visible, clears any per-round diff
 * scope, forces a fresh diff read, and switches into replay mode. Shared by
 * the composer "Files" pill and the git-diff actions menu's "View in Agent
 * station" entry.
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { replayModeAtom } from "@src/engines/SessionCore";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  STATION_MODE,
  bumpSimulatorDiffRefreshNonceAtom,
  simulatorDiffScopeRequestAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";

export function useChatViewAgentStationDiff() {
  const setStationMode = useSetAtom(stationModeAtom);
  const setSelectedSimulatorApp = useSetAtom(simulatorSelectedAppAtom);
  const setReplayMode = useSetAtom(replayModeAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const setDiffScope = useSetAtom(simulatorDiffScopeRequestAtom);
  const refreshDiff = useSetAtom(bumpSimulatorDiffRefreshNonceAtom);

  return useCallback(() => {
    // Un-maximize the chat panel so ActivitySimulator becomes visible.
    // When chatPanelMaximized is true, AppShellContent suppresses the
    // simulator pane entirely (chatPanelFocused guard), so switching to
    // the Diff app would have no visible effect.
    //
    // Clear any per-round scope set by a chat `TurnMetadataFooter` so this
    // composer-level entry point always shows the whole-session diff.
    setDiffScope(null);
    // Force a fresh read of the canonical diffs so the full-session view
    // reflects edits made since the Diff app last cached them.
    refreshDiff();
    setChatPanelMaximized(false);
    setStationMode(STATION_MODE.AGENT_STATION);
    setSelectedSimulatorApp(AppType.DIFF);
    setReplayMode("replay");
  }, [
    setDiffScope,
    refreshDiff,
    setChatPanelMaximized,
    setReplayMode,
    setSelectedSimulatorApp,
    setStationMode,
  ]);
}
