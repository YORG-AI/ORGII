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
import { isMacOS } from "@src/util/platform/tauri";

const COLLAPSED_SIDEBAR_BUTTON_LEFT_INSET = 8;
const COLLAPSED_SIDEBAR_BUTTON_RESERVED_WIDTH = 30;
const MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH = 80;

export function getCollapsedSidebarChromeOffset(): number {
  return (
    (isMacOS() ? MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH : 0) +
    COLLAPSED_SIDEBAR_BUTTON_LEFT_INSET +
    COLLAPSED_SIDEBAR_BUTTON_RESERVED_WIDTH
  );
}

export function getCollapsedSidebarButtonLeft(): number {
  return (
    (isMacOS() ? MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH : 0) +
    COLLAPSED_SIDEBAR_BUTTON_LEFT_INSET
  );
}

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
