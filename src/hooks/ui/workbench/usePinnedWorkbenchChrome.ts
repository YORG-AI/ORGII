/**
 * Where the window's right-edge chrome (hide/restore chat, maximize chat /
 * show workstation) is drawn and who has to make room for it.
 *
 * On macOS the two collapse toggles are pinned in window space by
 * `PinnedWorkbenchChrome`, mirroring the sidebar group on the left: the chat
 * slot animates its width and the workstation slides with it, so a toggle
 * drawn inside either pane moved during the transition. Whichever pane
 * touches the window's right edge reserves the footprint underneath.
 */
import { useAtomValue } from "jotai";
import { useLocation } from "react-router-dom";

import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import {
  chatPanelMaximizedAtom,
  chatWidthAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import { chatPanelPositionAtom } from "@src/store/ui/workStationAtom";
import { isMacOS } from "@src/util/platform/tauri";

/** Two 28px icon buttons with the tab bar's 1px gap. */
export const PINNED_WORKBENCH_CHROME_WIDTH = 28 + 1 + 28;
/** Distance from the window's right edge, matching the tab bars' `pr-2`. */
export const PINNED_WORKBENCH_CHROME_RIGHT_INSET = 8;
/** Same vertical anchor as the left group. */
export const PINNED_WORKBENCH_CHROME_CENTER_TOP = 26;

/** Right padding a host needs so its own controls clear the pinned group. */
export function getPinnedWorkbenchChromeReservedRight(): number {
  return (
    PINNED_WORKBENCH_CHROME_RIGHT_INSET + PINNED_WORKBENCH_CHROME_WIDTH + 1
  );
}

export function isPinnedWorkbenchChromePath(pathname: string): boolean {
  const settings = ROUTES.app.settings.path;
  const inSettings =
    pathname === settings || pathname.startsWith(`${settings}/`);
  return isWorkbenchPath(pathname) && !inSettings;
}

/** True where `PinnedWorkbenchChrome` draws: macOS, on a workbench route (Settings owns its own maximize control). */
export function usePinnedWorkbenchChromeVisible(): boolean {
  const location = useLocation();
  return isMacOS() && isPinnedWorkbenchChromePath(location.pathname);
}

export type WorkbenchRightEdgeOwner = "chat" | "workstation";

/** Which pane currently touches the window's right edge, or null when nothing is pinned there. */
export function useWorkbenchRightEdgeOwner(): WorkbenchRightEdgeOwner | null {
  const pinned = usePinnedWorkbenchChromeVisible();
  const stationChatVisibility = useAtomValue(stationChatVisibilityAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  if (!pinned) return null;
  const chatVisible = stationChatVisibility["my-station"] && chatWidth > 0;
  return chatPanelMaximized || (chatVisible && chatPanelPosition === "right")
    ? "chat"
    : "workstation";
}
