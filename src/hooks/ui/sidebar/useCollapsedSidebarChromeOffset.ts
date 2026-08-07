import { useAtomValue } from "jotai";

import {
  chatPanelMaximizedAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  type ChatPanelPosition,
  sessionChatPositionAtom,
  workStationChatPositionAtom,
} from "@src/store/ui/workStationLayout/chatPositionAtoms";

export const COLLAPSED_SIDEBAR_CHROME_OFFSET = 118;

export function useShouldOffsetWorkStationTopBar(): boolean {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const stationMode = useAtomValue(stationModeAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const workStationChatPosition = useAtomValue(workStationChatPositionAtom);
  const sessionChatPosition = useAtomValue(sessionChatPositionAtom);

  const activeChatPosition =
    stationMode === "agent-station"
      ? sessionChatPosition
      : workStationChatPosition;
  const chatOccupiesLeftEdge = chatWidth > 0 && activeChatPosition === "left";

  return sidebarCollapsed && !chatPanelMaximized && !chatOccupiesLeftEdge;
}

export function useShouldOffsetChatPanelHeader(options: {
  position: ChatPanelPosition;
  useExternalWidth: boolean;
}): boolean {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const stationMode = useAtomValue(stationModeAtom);

  if (!sidebarCollapsed) return false;
  if (options.useExternalWidth) return true;
  if (stationMode === "agent-station") return options.position === "left";

  return options.position === "left";
}

export function useShouldOffsetMainAppHeader(): boolean {
  return useAtomValue(sidebarCollapsedAtom);
}
