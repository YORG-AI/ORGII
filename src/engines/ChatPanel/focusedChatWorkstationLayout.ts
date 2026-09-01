import {
  FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_WIDTH,
} from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

/**
 * Width at which a maximized chat pane is wide enough to give the
 * conversation minimap a column of its own. Below it the pane is as tight as
 * a side pane, so the rail floats over the transcript there instead of
 * taking 36px the transcript cannot spare.
 */
export const FOCUSED_CHAT_MINIMAP_COLUMN_CONTAINER_PX = 850;

/**
 * Host for the conversation minimap inside the trail column.
 *
 * In-flow from 850px up, where the track reserves the rail's 36px (see
 * `resolveFocusedChatWorkstationRailTrackClass`). Below that the track is
 * zero-width and the host is a 36px box pinned to the pane's right edge —
 * the same box the side pane's rail floats in, so the pill inside lands on
 * the identical spot in both.
 */
export const FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS =
  "pointer-events-none absolute right-0 top-0 h-full w-9 @[850px]/focusedchat:relative @[850px]/focusedchat:ml-auto @[850px]/focusedchat:h-auto @[850px]/focusedchat:min-h-0 @[850px]/focusedchat:flex-1";

export function resolveFocusedChatWorkstationSectionOrder(
  hasOpenTabs: boolean,
  hasSessionEnvironment: boolean,
  hasSubagents = false
): Array<"session" | "workspace" | "subagents" | "tabs"> {
  return [
    "workspace",
    ...(hasSessionEnvironment ? (["session"] as const) : []),
    // The session's spawned workers sit right under the environment that ran
    // them, before the unrelated open-tabs list.
    ...(hasSubagents ? (["subagents"] as const) : []),
    ...(hasOpenTabs ? (["tabs"] as const) : []),
  ];
}

export function isSameFocusedChatGitEnvironment({
  localBranchName,
  localRepoPath,
  sessionBranchName,
  sessionRepoPath,
}: {
  localBranchName?: string;
  localRepoPath?: string;
  sessionBranchName?: string;
  sessionRepoPath?: string;
}): boolean {
  if (
    !localBranchName ||
    !localRepoPath ||
    !sessionBranchName ||
    !sessionRepoPath
  ) {
    return false;
  }
  const normalize = (value: string) => value.replace(/[\\/]+$/u, "");
  return (
    localBranchName === sessionBranchName &&
    normalize(localRepoPath) === normalize(sessionRepoPath)
  );
}

interface FocusedChatWorkstationMountInput {
  activeTabType: ChatPanelTab["type"] | null;
  isChatFocus: boolean;
  showSessionContent: boolean;
}

interface FocusedChatWorkstationPlaceholderInput {
  activeTabType: ChatPanelTab["type"] | null;
  isChatFocus: boolean;
  startPageOpen: boolean;
}

/**
 * The environment rail owns a live working-tree subscription, so it only
 * mounts while a maximized session is actually presenting session content.
 */
export function shouldMountFocusedChatWorkstationControls({
  activeTabType,
  isChatFocus,
  showSessionContent,
}: FocusedChatWorkstationMountInput): boolean {
  return isChatFocus && activeTabType === "session" && showSessionContent;
}

/**
 * Keep focused Launchpad content aligned with a session using the collapsed
 * workstation track, without mounting the rail's live data or controls.
 */
export function shouldReserveFocusedChatWorkstationPlaceholder({
  activeTabType,
  isChatFocus,
  startPageOpen,
}: FocusedChatWorkstationPlaceholderInput): boolean {
  return isChatFocus && activeTabType === "start-page" && startPageOpen;
}

/**
 * Width of the trail column, in three steps.
 *
 * Under 850px the pane is too tight to spend 36px on chrome, so the column
 * is zero and the minimap floats over the transcript exactly as it does in a
 * non-maximized pane. From 850px the column reserves the minimap's rail. At
 * 1100px the trail surface itself arrives and takes over the width.
 */
export function resolveFocusedChatWorkstationRailTrackClass(
  collapsed: boolean
): string {
  return collapsed
    ? `w-0 @[850px]/focusedchat:w-9 ${WORKSTATION_TRAIL_WIDTH.collapsedResponsiveClass} ${FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`
    : `w-0 @[850px]/focusedchat:w-9 ${WORKSTATION_TRAIL_WIDTH.resizableResponsiveClass} ${FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`;
}

/** Keep the rail below overlaid chat chrome while the transcript scrolls behind it. */
export function resolveFocusedChatWorkstationRailInsetStyle(topInset: number): {
  height?: string;
  marginTop?: string;
} {
  if (topInset <= 0) return {};
  return {
    marginTop: `${topInset}px`,
    height: `calc(100% - ${topInset}px)`,
  };
}
