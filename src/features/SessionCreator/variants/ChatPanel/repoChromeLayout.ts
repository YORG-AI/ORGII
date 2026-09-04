import type { CreatorRepoChromePosition } from "@src/store/session";

import type { SessionCreatorChatPanelHeaderLayout } from "./types";

export const REPO_CHROME_POSITION_CLASS: Record<
  CreatorRepoChromePosition,
  string
> = {
  top: "session-creator-chat-panel-fullscreen-repo-row-above pb-2.5 pt-1.5",
  bottom: "session-creator-chat-panel-fullscreen-repo-row-below pb-1.5 pt-2.5",
};

export function isRepoChromeAboveComposer(
  position: CreatorRepoChromePosition
): boolean {
  return position === "top";
}

export function shouldUseCreatorComposerBreathing(
  isLaunchpadLayout: boolean,
  position: CreatorRepoChromePosition,
  hasMovableRepoChrome: boolean
): boolean {
  return isLaunchpadLayout && (!hasMovableRepoChrome || position === "top");
}

export function shouldShowCreatorPinnedActions(
  headerLayout: SessionCreatorChatPanelHeaderLayout,
  hasRepoChromeMenu: boolean,
  pinnedActionsVisible: boolean
): boolean {
  if (headerLayout === "compact") return pinnedActionsVisible;
  return !hasRepoChromeMenu || pinnedActionsVisible;
}
