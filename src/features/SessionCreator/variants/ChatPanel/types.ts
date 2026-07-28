import type React from "react";

import type {
  ChatPanelCliTerminalLaunchOptions,
  ChatPanelRegionNotice,
} from "@src/engines/ChatPanel/types";
import type {
  SessionLaunchSuccessInfo,
  SessionLaunchWorkItemContext,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import type { SessionCreatorLaunchMode } from "@src/features/SessionCreator/types";

import type { DropdownDirection } from "../../components/ControlButtons";

export type SessionCreatorChatPanelVariant = "default" | "fullScreen";
export type SessionCreatorChatPanelHeaderLayout = "hero" | "compact";

export interface SessionCreatorChatPanelProps {
  centerFullScreenContent?: boolean;
  className?: string;
  /** Optional content rendered at the top of the composer input shell. */
  composerHeaderContent?: React.ReactNode;
  /** Optional content rendered in the pinned Skills & Tools row. */
  pinnedActionsContent?: React.ReactNode;
  /** Override classes on the inner content-padding div (e.g. to reduce bottom padding). */
  innerClassName?: string;
  footerSlot?: React.ReactNode;
  leadingActionSlot?: React.ReactNode;
  headerLayout?: SessionCreatorChatPanelHeaderLayout;
  hideRepoLine?: boolean;
  /** Hide the work-item attachment action when the composer already creates one. */
  hideWorkItemAttachmentControl?: boolean;
  /** Whether the category picker may select Work log. Agent-only embedded creators disable it. */
  includeHumanSession?: boolean;
  initialContent?: string;
  dropdownDirection?: DropdownDirection;
  onOpenCliTerminal?: (options: ChatPanelCliTerminalLaunchOptions) => void;
  onRegionNoticeChange?: (notice: ChatPanelRegionNotice | null) => void;
  onSessionStart?: (info: SessionLaunchSuccessInfo) => void;
  variant?: SessionCreatorChatPanelVariant;
  workItemContext?: SessionLaunchWorkItemContext;
  resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
}

export interface SessionCreatorChatPanelSingleProps extends SessionCreatorChatPanelProps {
  hidePresenceButton?: boolean;
  launchMode?: SessionCreatorLaunchMode;
}
