/**
 * ChatHistory Hooks
 *
 * Exports hooks for ChatHistory state, optimization, grouping, search,
 * scroll, and pagination.
 */

export { useChatHistoryState } from "./useChatHistoryState";
export type {
  UseChatHistoryStateProps,
  UseChatHistoryStateReturn,
} from "./useChatHistoryState";

export { useChatHistoryProjectionModel } from "./useChatHistoryProjectionModel";
export { useChatHistoryItemActions } from "./useChatHistoryItemActions";
export {
  resolveConversationHistoryPageIndex,
  useChatNavigationController,
} from "./useChatNavigationController";
export { useChatViewportController } from "./useChatViewportController";

export { isTurnCollapseEligible, useChatGroups } from "./useChatGroups";
export type { ChatGroupMeta, UseChatGroupsReturn } from "./useChatGroups";

export { useChatSearch } from "./useChatSearch";
export type { UseChatSearchReturn } from "./useChatSearch";

export { useChatPagination } from "./useChatPagination";
export type {
  UseChatPaginationOptions,
  UseChatPaginationReturn,
} from "./useChatPagination";

export { useChatTurnPagination } from "./useChatTurnPagination";
export type { UseChatTurnPaginationReturn } from "./useChatTurnPagination";

export { useChatScroll } from "./useChatScroll";
export type {
  UseChatScrollOptions,
  UseChatScrollReturn,
} from "./useChatScroll";

export { useChatFooterSpacer } from "./useChatFooterSpacer";
export type {
  UseChatFooterSpacerOptions,
  UseChatFooterSpacerReturn,
} from "./useChatFooterSpacer";

export { useEditUserMessage } from "./useEditUserMessage";

export { useRestoreCheckpoint } from "./useRestoreCheckpoint";

export { useChatEmptyState } from "./useChatEmptyState";
export type {
  UseChatEmptyStateOptions,
  UseChatEmptyStateReturn,
} from "./useChatEmptyState";

export { useChatScrollPin } from "./useChatScrollPin";
export type {
  UseChatScrollPinOptions,
  UseChatScrollPinReturn,
} from "./useChatScrollPin";

export { useGroupHeaderRenderer } from "./useGroupHeaderRenderer";

export { useReloadSession } from "./useReloadSession";
export {
  findTailTurnId,
  TAIL_TURN_STALE_MS,
  useTailTurnPhase,
} from "./useTailTurnCollapse";
export {
  useTurnPageNavigation,
  useTurnPageSelectionState,
} from "./useTurnPageSelection";
export type {
  UseTurnPageNavigationReturn,
  UseTurnPageSelectionStateReturn,
} from "./useTurnPageSelection";
