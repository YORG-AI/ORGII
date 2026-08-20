import {
  FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_WIDTH,
} from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

export const FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS =
  "pointer-events-none absolute right-0 top-0 h-full w-9 @[1100px]/focusedchat:relative @[1100px]/focusedchat:ml-auto @[1100px]/focusedchat:h-auto @[1100px]/focusedchat:min-h-0 @[1100px]/focusedchat:flex-1";

export function resolveFocusedChatWorkstationSectionOrder(
  hasOpenTabs: boolean,
  hasSessionEnvironment: boolean
): Array<"session" | "workspace" | "tabs"> {
  return [
    ...(hasSessionEnvironment ? (["session"] as const) : []),
    "workspace",
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

export function resolveFocusedChatWorkstationRailTrackClass(
  collapsed: boolean
): string {
  return collapsed
    ? `w-0 ${WORKSTATION_TRAIL_WIDTH.collapsedResponsiveClass} ${FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`
    : `w-0 ${WORKSTATION_TRAIL_WIDTH.expandedResponsiveClass} ${FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`;
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
