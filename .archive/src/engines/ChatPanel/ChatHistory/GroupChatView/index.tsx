/**
 * Group chat helpers — merged event feed for Agent Team runs.
 *
 * Rendering uses the regular `ChatHistory` pipeline via
 * `ChatHistoryOverrideContext`; this folder only owns merge logic,
 * sender metadata, and task-assignment prompt parsing.
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
export {
  AgentEventsTap,
  useGroupChatMergedEvents,
} from "./useGroupChatMergedEvents";
