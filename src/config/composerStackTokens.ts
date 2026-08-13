/**
 * Composer stack UI tokens
 *
 * Shared Tailwind class strings for:
 * - Stacked sections above the chat composer (queue, file changes, processes, …)
 * - Chat history blocks that should match the same row/surface look (e.g. todo list)
 *
 * Not input-area-specific — only named "composer" for historical reasons.
 */

// ==============================================
// Shell — outer bar above composer (width, border, background)
// ==============================================

/** Shared distance between every bottom-docked input/composer and the page edge. */
export const COMPOSER_BOTTOM_DOCK_PADDING_CLASS = "pb-3";

/** Shell border — stacks above input; no bottom border. Matches composer card border weight. */
export const CHAT_COMPOSER_STACK_BAR_SHELL_CLASSES =
  "border-x border-t border-solid border-border-2";

/** Surface background for queue + file-review bars (matches the chat input box). */
export const CHAT_COMPOSER_STACK_BAR_SURFACE_BG_CLASS = "bg-chat-input";

/** Standalone card shell — border + bg + radius. Applied to each full-card section (question, permission, mode-switch). */
export const COMPOSER_CARD_SHELL_CLASSES =
  "bg-chat-input rounded-lg border border-solid border-border-2 overflow-hidden";

/** Inner horizontal padding for stack list bodies and headers. */
export const CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS = "px-1";

/**
 * Body layout for expandable stack-style lists in chat tool blocks (Glob, Explore flat,
 * manage_workspace, search_files). Matches composer stack row density — do not duplicate ad hoc.
 */
export const CHAT_EXPANDABLE_STACK_LIST_BODY_CLASSES = `space-y-0.5 ${CHAT_COMPOSER_STACK_BAR_INNER_PADDING_X_CLASS} pt-1`;

// ==============================================
// Rows — list rows inside an expanded stack section
// ==============================================

/**
 * Base row class for expanded stack content (queued messages, processes, file rows, chat todo rows).
 * Consumers append hover, drag cursors, etc.
 */
export const COMPOSER_STACK_ROW_BASE =
  "group flex h-8 items-center gap-1.5 rounded px-1.5 transition-colors";

/** Default hover for non-active stack rows on composer stack surfaces. */
export const COMPOSER_STACK_ROW_HOVER = "hover:bg-fill-1";

/** Primary text in a stack row — single-line truncated label. */
export const COMPOSER_STACK_ROW_LABEL =
  "chat-block-title min-w-0 flex-1 truncate text-text-2";

/**
 * Secondary column — right-aligned muted path (parent dir, full path, etc.).
 * Pushes to the trailing edge via `flex-1` + `text-right`.
 */
export const COMPOSER_STACK_ROW_SECONDARY =
  "min-w-0 flex-1 truncate text-right text-text-3";

/**
 * Info-card variant label — stronger left key for `key: value` rows
 * (e.g. `manage_workspace` mutation info). Pair with {@link COMPOSER_STACK_ROW_SECONDARY_INFO}.
 */
export const COMPOSER_STACK_ROW_LABEL_INFO =
  "chat-block-title min-w-0 flex-1 truncate text-text-1";

/**
 * Info-card variant secondary — slightly smaller, less muted than the path variant,
 * for right-aligned values in `key: value` rows.
 */
export const COMPOSER_STACK_ROW_SECONDARY_INFO =
  "min-w-0 flex-1 truncate text-right text-[11px] leading-[1.5] text-text-2";

/** Hover-visible action tray at the end of a stack row. */
export const COMPOSER_STACK_ROW_ACTIONS =
  "invisible ml-auto flex shrink-0 items-center gap-0.5 group-hover:visible";
