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

export { isTurnCollapseEligible, useChatGroups } from "./useChatGroups";
export type { ChatGroupMeta, UseChatGroupsReturn } from "./useChatGroups";

export { useChatHistoryOptimization } from "./useChatHistoryOptimization";
export type { UseChatHistoryOptimizationReturn } from "./useChatHistoryOptimization";

export { useChatSearch } from "./useChatSearch";
export type {
  SearchResult,
  UseChatSearchOptions,
  UseChatSearchReturn,
} from "./useChatSearch";

export { useChatSearchIntegration } from "./useChatSearchIntegration";
export type {
  UseChatSearchIntegrationOptions,
  UseChatSearchIntegrationReturn,
} from "./useChatSearchIntegration";

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
  useTurnPageNavigation,
  useTurnPageSelectionState,
} from "./useTurnPageSelection";
export type {
  UseTurnPageNavigationReturn,
  UseTurnPageSelectionStateReturn,
} from "./useTurnPageSelection";
