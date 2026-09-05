import { useAtomValue } from "jotai";

import { SESSION_HISTORY_NAV_WIDTH } from "@src/components/SessionHistoryNav";
import {
  chatPanelMaximizedAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import {
  type ChatPanelPosition,
  chatPanelPositionAtom,
} from "@src/store/ui/workStationLayout/chatPositionAtoms";
import { isMacOS } from "@src/util/platform/tauri";

const COLLAPSED_SIDEBAR_BUTTON_LEFT_INSET = 8;
const COLLAPSED_SIDEBAR_BUTTON_RESERVED_WIDTH = 30;
/** Back / Forward pair (`SESSION_HISTORY_NAV_WIDTH`) plus its 4px gap to the toggle. */
const COLLAPSED_SIDEBAR_HISTORY_NAV_RESERVED_WIDTH =
  SESSION_HISTORY_NAV_WIDTH + 4;
const MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH = 80;
/**
 * Vertical center of the 36px title-bar row every host places its chrome in
 * (8px top breathing room + half the row). The pinned macOS group and each
 * host's own collapsed toggle share it so nothing shifts between states.
 */
export const COLLAPSED_SIDEBAR_CHROME_CENTER_TOP = 26;

export function getCollapsedSidebarChromeOffset(): number {
  return (
    (isMacOS() ? MACOS_TRAFFIC_LIGHTS_RESERVED_WIDTH : 0) +
    COLLAPSED_SIDEBAR_BUTTON_LEFT_INSET +
    COLLAPSED_SIDEBAR_HISTORY_NAV_RESERVED_WIDTH +
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
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const chatOccupiesLeftEdge = chatWidth > 0 && chatPanelPosition === "left";

  return sidebarCollapsed && !chatPanelMaximized && !chatOccupiesLeftEdge;
}

export function useShouldOffsetChatPanelHeader(options: {
  position: ChatPanelPosition;
  useExternalWidth: boolean;
}): boolean {
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  if (!sidebarCollapsed) return false;
  if (options.useExternalWidth) return true;

  return options.position === "left";
}

export function useShouldOffsetMainAppHeader(): boolean {
  return useAtomValue(sidebarCollapsedAtom);
}
