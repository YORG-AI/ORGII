import type { ReactNode } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import type { ChatHistoryDisplayMode } from "@src/store/ui/chatPanelAtom";

export interface FollowAgentNavState {
  showFollowAgent: boolean;
  followAgentLabel: string;
  followAgentTooltipLabel: string;
  followAgentShortcut: string;
  onFollowAgent: () => void;
}

export interface BrowserAddToConversationNavState {
  showAddToConversation: boolean;
  addToConversationLabel: string;
  addToConversationTooltipLabel: string;
  cancelAddToConversationLabel: string;
  onAddToConversation: () => void;
  onCancelAddToConversation: () => void;
}

export interface ScrollNavState
  extends FollowAgentNavState, BrowserAddToConversationNavState {
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
}

export const EMPTY_FOLLOW_AGENT_NAV: FollowAgentNavState = {
  showFollowAgent: false,
  followAgentLabel: "",
  followAgentTooltipLabel: "",
  followAgentShortcut: "",
  onFollowAgent: () => undefined,
};

export const EMPTY_BROWSER_ADD_TO_CONVERSATION_NAV: BrowserAddToConversationNavState =
  {
    showAddToConversation: false,
    addToConversationLabel: "",
    addToConversationTooltipLabel: "",
    cancelAddToConversationLabel: "",
    onAddToConversation: () => undefined,
    onCancelAddToConversation: () => undefined,
  };

export interface ChatHistoryProps {
  /** Opaque background class for sticky headers. Must match the container surface. */
  surfaceBgClass?: string;
  /** Dock side of the containing chat panel, used by narrow side previews. */
  chatPanelPosition?: "left" | "right";
  agentOrgCurrentMemberName?: string | null;
  /**
   * Stable identifier of the member currently being viewed in the chat
   * pipeline. The member switcher uses this because names are not unique.
   */
  agentOrgCurrentMemberId?: string | null;
  agentOrgMembers?: AgentOrgRunMemberView[];
  agentOrgOverviewPanel?: ReactNode;
  onAgentOrgMemberSelect?: (member: AgentOrgRunMemberView) => void;
  onAgentOrgRunViewRefresh?: () => Promise<void>;
  /** Publishes scroll-navigation visibility and handlers to the containing chat view. */
  onScrollNavChange?: (state: ScrollNavState) => void;
  followAgentNav?: FollowAgentNavState;
  browserAddToConversationNav?: BrowserAddToConversationNavState;
  displayMode?: ChatHistoryDisplayMode;
  turnPaginationEnabled?: boolean;
  /** Optional external host for pinned/pagination chrome, outside the scroll body subtree. */
  pinnedHeaderPortalHost?: HTMLElement | null;
  /** Floating chrome height transcript offsets must clear (0 = in-flow chrome). */
  chromeTopInset?: number;
  /** Height in px of the overlapping input area, used to keep the last message reachable. */
  bottomInset?: number;
  /**
   * Default every multi-item turn to collapsed while still allowing the user
   * to expand a turn from its in-history collapse control.
   */
  forceCollapseAllTurns?: boolean;
  /**
   * Suppress the idle-tail collapse rule. Compact subagent panes use this to
   * keep their surfaced turn expanded.
   */
  disableTailCollapse?: boolean;
  /** Trailing content for turn pagination controls; ignored when pagination is disabled. */
  paginationTrailingSlot?: ReactNode;
  /** Omit each turn's leading user-message card while retaining its turn boundary. */
  hideGroupUserMessage?: boolean;
  /** Label painted above each turn's last visible item. */
  newEventDividerLabel?: string | null;
  groupChatViewAvailable?: boolean;
  groupChatViewActive?: boolean;
  onGroupChatViewToggle?: (active: boolean) => void;
  mutationActionsDisabled?: boolean;
  /**
   * Session-scoped source for the planning footer. Session-scoped surfaces
   * should set `isLive` to false while showing a replay slice.
   */
  planningIndicatorScope?: { sessionId: string; isLive: boolean } | null;
}
