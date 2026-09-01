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
export type SessionCreatorChatPanelLayout = "default" | "launchpad";
/**
 * What the launchpad prompt says the composer produces. Sessions and projects
 * get built; a work item is written down before anything is built, so its
 * creator asks what to plan instead.
 */
export type SessionCreatorLaunchpadIntent = "build" | "plan";

export interface SessionCreatorChatPanelProps {
  centerFullScreenContent?: boolean;
  className?: string;
  /** Optional content rendered at the top of the composer input shell. */
  composerHeaderContent?: React.ReactNode;
  /** Launchpad-only actions displayed below the centered agent prompt. */
  heroFooterSlot?: React.ReactNode;
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
  /** Launchpad keeps the identity prompt centered and the composer docked below it. */
  layout?: SessionCreatorChatPanelLayout;
  /** Wording of the launchpad question. Defaults to "build". */
  launchpadIntent?: SessionCreatorLaunchpadIntent;
  dropdownDirection?: DropdownDirection;
  onOpenCliTerminal?: (options: ChatPanelCliTerminalLaunchOptions) => void;
  onRegionNoticeChange?: (notice: ChatPanelRegionNotice | null) => void;
  onSessionStart?: (info: SessionLaunchSuccessInfo) => void;
  /**
   * Render this creator as the **Compare runners** launcher: a runner list in
   * place of the agent hero, and a send that fans the prompt out to every
   * runner. Set only by that create target — the Session, work-item and
   * project launchers each start exactly one agent.
   */
  multiRunnerLauncher?: boolean;
  /** Leave the Compare-runners launcher for the single-agent Session tab. */
  onExitMultiRunner?: () => void;
  variant?: SessionCreatorChatPanelVariant;
  workItemContext?: SessionLaunchWorkItemContext;
  resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
}

export interface SessionCreatorChatPanelSingleProps extends SessionCreatorChatPanelProps {
  hidePresenceButton?: boolean;
  launchMode?: SessionCreatorLaunchMode;
}
