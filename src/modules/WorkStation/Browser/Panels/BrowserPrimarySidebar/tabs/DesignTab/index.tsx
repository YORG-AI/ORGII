// Default export
import { getGlobalTokensActions, getPagesActions } from "./actions";
import { DesignTabGlobalTokens, DesignTabPages } from "./sections";

/**
 * DesignTab - Components browser for the primary sidebar
 *
 * Two sections:
 * - Global Tokens: Repository design tokens
 *
 * Filter visibility follows explorer pattern:
 * - Hidden by default
 * - Toggle via header action button
 * - Query cleared when filter is hidden
 */

// Re-export all section components
export { DesignTabPages, DesignTabGlobalTokens } from "./sections";

// Re-export all action functions
export { getGlobalTokensActions } from "./actions";

// Re-export types
export type {
  PageItem,
  DesignTabPagesProps,
  DesignTabGlobalTokensProps,
  ActionItem,
  PagesActionsOptions,
  GlobalTokensActionsOptions,
} from "./types";

export default {
  DesignTabPages,
  DesignTabGlobalTokens,
  getPagesActions,
  getGlobalTokensActions,
};
