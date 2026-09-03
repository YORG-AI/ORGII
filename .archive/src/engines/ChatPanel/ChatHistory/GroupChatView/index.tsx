/**
 * Legacy single-Session rendering helpers retained for non-projection views.
 *
 * The Agent Team Group surface does not import this barrel: it renders the
 * bounded backend projection directly in `AgentOrgGroupProjectionView`.
 */
export { GroupChatProvider, useGroupChatContext } from "./GroupChatContext";
export type { GroupChatContextValue } from "./GroupChatContext";
export { default as GroupChatMessageBubble } from "./GroupChatMessageBubble";
export {
  buildGroupChatSessionEvents,
  extractGroupMessageContent,
  isCoordinatorHumanUserEvent,
  resolveGroupChatMessageBubble,
  resolveGroupChatToolUseSummary,
  resolveGroupMessageRecipient,
  resolveGroupSenderName,
  resolveGroupSenderNameForSession,
} from "./groupChatUtils";
export type {
  GroupChatMessageBubbleContent,
  GroupChatToolUseSummary,
} from "./groupChatUtils";
export { parseTaskAssignedPrompt } from "./parseTaskAssignedPrompt";
export type { ParsedTaskAssignedPrompt } from "./parseTaskAssignedPrompt";
export type { GroupChatAgent } from "./types";
export { buildAgentList } from "./useGroupChatFeed";
