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
  /** Optional content attached above the composer input, matching the session info row below it. */
  composerHeaderContent?: React.ReactNode;
  /** Override classes on the inner content-padding div (e.g. to reduce bottom padding). */
  innerClassName?: string;
  footerSlot?: React.ReactNode;
  leadingActionSlot?: React.ReactNode;
  headerLayout?: SessionCreatorChatPanelHeaderLayout;
  hideRepoLine?: boolean;
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
