import type { ComponentType, ReactNode } from "react";

import type { CliAgentType } from "@src/api/types/keys";
import type {
  SessionLaunchSuccessInfo,
  SessionLaunchWorkItemContext,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import type { SessionCreatorLaunchMode } from "@src/features/SessionCreator/types";

export interface ChatPanelRegionNotice {
  key: string;
  title: string;
  body: string;
}

export interface ChatPanelCliTerminalLaunchOptions {
  cliAgentType: CliAgentType;
  command: string;
  title: string;
  cwd?: string;
  expectedProcess?: string;
  /**
   * Managed `code_sessions` row backing this TUI launch (`runner = 'tui'`).
   * Injected into the PTY as `ORGII_SESSION_ID` so lifecycle hooks attribute
   * status and transcripts to it; absent when session creation failed and
   * the terminal runs unbound.
   */
  agentSessionId?: string;
}

/**
 * Props for the main ChatPanel component
 */
export interface ChatPanelProps {
  /** Whether to use external width management */
  useExternalWidth?: boolean;
  /** Session sidebar width for layout calculations */
  sessionSidebarWidth?: number;
  /**
   * Whether ChatPanel is embedded inside another container.
   * When true, removes external border radius for seamless integration.
   */
  embedded?: boolean;
  /**
   * Whether the docked chat surface is active for the current station.
   * When false, the panel shell may stay mounted for layout persistence,
   * but it must not mount ChatView/SessionCreator or claim session sync.
   */
  active?: boolean;
  /**
   * Position of the chat panel.
   * Affects drag handle position, border side, and header ordering.
   * @default "right"
   */
  position?: "left" | "right";
  /**
   * Slot for session creator UI rendered when no session is active.
   * Injected by the parent to avoid ChatPanel depending on SessionCreator.
   */
  sessionCreatorSlot?: ComponentType<{
    className?: string;
    variant?: "default" | "fullScreen";
    centerFullScreenContent?: boolean;
    composerHeaderContent?: ReactNode;
    pinnedActionsContent?: ReactNode;
    footerSlot?: ReactNode;
    innerClassName?: string;
    leadingActionSlot?: ReactNode;
    hideRepoLine?: boolean;
    hideWorkItemAttachmentControl?: boolean;
    includeHumanSession?: boolean;
    onRegionNoticeChange?: (notice: ChatPanelRegionNotice | null) => void;
    hidePresenceButton?: boolean;
    initialContent?: string;
    launchMode?: SessionCreatorLaunchMode;
    onOpenCliTerminal?: (options: ChatPanelCliTerminalLaunchOptions) => void;
    onSessionStart?: (info: SessionLaunchSuccessInfo) => void;
    resolveWorkItemContext?: () => Promise<SessionLaunchWorkItemContext | null>;
    workItemContext?: SessionLaunchWorkItemContext;
  }>;
}
