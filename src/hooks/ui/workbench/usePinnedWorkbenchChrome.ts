/**
 * Where the window's right-edge chrome (hide/restore chat, maximize chat /
 * show workstation) is drawn and who has to make room for it.
 *
 * On macOS an empty station pins the two collapse toggles in window space by
 * `PinnedWorkbenchChrome`, mirroring the sidebar group on the left. Once the
 * station has content, the fixed side-pane group is withheld so pane-owned
 * `+` / expand controls remain unobstructed. While the pinned group is active,
 * whichever pane touches the window's right edge reserves its footprint.
 */
import { useAtomValue } from "jotai";
import { useLocation } from "react-router-dom";

import { ROUTES, isWorkbenchPath } from "@src/config/routes";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import {
  chatPanelMaximizedAtom,
  chatWidthAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { chatPanelPositionAtom } from "@src/store/ui/workStationAtom";
import { mainPaneHasRealTabsAtom } from "@src/store/workstation/tabHost";
import type { StationMode } from "@src/types/ui/workstation";
import { isMacOS } from "@src/util/platform/tauri";

/** One 28px icon button. */
export const PINNED_WORKBENCH_CHROME_BUTTON_WIDTH = 28;
/** The tab bar's 1px gap between adjacent buttons. */
export const PINNED_WORKBENCH_CHROME_GAP = 1;
/** Distance from the window's right edge, matching the tab bars' `pr-2`. */
export const PINNED_WORKBENCH_CHROME_RIGHT_INSET = 8;
/** Same vertical anchor as the left group. */
export const PINNED_WORKBENCH_CHROME_CENTER_TOP = 26;

export type PinnedWorkbenchChromeSlots = 1 | 2;

/**
 * How many slots the group draws: both toggles while the chat pane shows
 * beside the workstation, one otherwise. A missing slot is dropped outright
 * rather than held as a spacer — a spacer only punches a hole between the
 * surviving toggle and the host's own controls.
 */
export function resolvePinnedWorkbenchChromeSlots(options: {
  chatVisible: boolean;
  chatPanelMaximized: boolean;
}): PinnedWorkbenchChromeSlots {
  return options.chatVisible && !options.chatPanelMaximized ? 2 : 1;
}

/** Right padding a host needs so its own controls clear the pinned group. */
export function getPinnedWorkbenchChromeReservedRight(
  slots: PinnedWorkbenchChromeSlots = 2
): number {
  return (
    PINNED_WORKBENCH_CHROME_RIGHT_INSET +
    slots * PINNED_WORKBENCH_CHROME_BUTTON_WIDTH +
    (slots - 1) * PINNED_WORKBENCH_CHROME_GAP +
    PINNED_WORKBENCH_CHROME_GAP
  );
}

export function isPinnedWorkbenchChromePath(pathname: string): boolean {
  const settings = ROUTES.app.settings.path;
  const inSettings =
    pathname === settings || pathname.startsWith(`${settings}/`);
  return isWorkbenchPath(pathname) && !inSettings;
}

interface PinnedWorkbenchChromeVisibility {
  baseVisible: boolean;
  stationMode: StationMode;
  myStationHasContent: boolean;
  agentStationHasContent: boolean;
}

/**
 * Empty stations use window-level side-pane controls. Once a station owns
 * real content, its pane headers own the `+` / expand controls instead; the
 * fixed group would otherwise sit over those trailing actions.
 */
export function shouldShowPinnedWorkbenchChrome({
  baseVisible,
  stationMode,
  myStationHasContent,
  agentStationHasContent,
}: PinnedWorkbenchChromeVisibility): boolean {
  if (!baseVisible) return false;
  return stationMode === "my-station"
    ? !myStationHasContent
    : !agentStationHasContent;
}

/**
 * Whether macOS owns side-pane chrome at the window level on this route.
 * Populated station headers use this to avoid restoring the same side-pane
 * actions after the fixed group is visually suppressed.
 */
export function usePinnedWorkbenchChromeAvailable(): boolean {
  const location = useLocation();
  return isMacOS() && isPinnedWorkbenchChromePath(location.pathname);
}

/** True where the empty-station `PinnedWorkbenchChrome` may draw. */
export function usePinnedWorkbenchChromeVisible(): boolean {
  const baseVisible = usePinnedWorkbenchChromeAvailable();
  const stationMode = useAtomValue(stationModeAtom);
  const myStationHasContent = useAtomValue(mainPaneHasRealTabsAtom);
  const agentStationHasContent = Boolean(
    useAtomValue(workstationActiveSessionIdAtom)
  );
  return shouldShowPinnedWorkbenchChrome({
    baseVisible,
    stationMode,
    myStationHasContent,
    agentStationHasContent,
  });
}

/**
 * Whether the chat pane is showing for the station currently on screen —
 * the layout's own rule. Visibility is stored per station (My Station /
 * Agent Station), so reading a fixed key would go blind in the other one.
 */
export function useCurrentStationChatVisible(): boolean {
  const stationMode = useAtomValue(stationModeAtom);
  const stationChatVisibility = useAtomValue(stationChatVisibilityAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const visible =
    stationMode in stationChatVisibility
      ? stationChatVisibility[stationMode as keyof typeof stationChatVisibility]
      : false;
  return visible && chatWidth > 0;
}

export type WorkbenchRightEdgeOwner = "chat" | "workstation";

export interface WorkbenchRightEdgeReservation {
  /** Which pane touches the window's right edge; null when nothing is pinned there. */
  owner: WorkbenchRightEdgeOwner | null;
  /** Right padding that pane must keep clear; 0 when nothing is pinned. */
  reservedRight: number;
}

/** Who reserves the right edge for the pinned group, and how much. */
export function useWorkbenchRightEdgeReservation(): WorkbenchRightEdgeReservation {
  const pinned = usePinnedWorkbenchChromeVisible();
  const chatVisible = useCurrentStationChatVisible();
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const chatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  if (!pinned) return { owner: null, reservedRight: 0 };
  const owner: WorkbenchRightEdgeOwner =
    chatPanelMaximized || (chatVisible && chatPanelPosition === "right")
      ? "chat"
      : "workstation";
  return {
    owner,
    reservedRight: getPinnedWorkbenchChromeReservedRight(
      resolvePinnedWorkbenchChromeSlots({ chatVisible, chatPanelMaximized })
    ),
  };
}
