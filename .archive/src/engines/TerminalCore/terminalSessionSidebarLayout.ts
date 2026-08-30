/**
 * Shared layout tokens for the terminal session / shell-command list column
 * (Code Editor bottom panel, Settings terminal preview, Simulator terminal panel).
 *
 * The vertical divider stays hidden until the pointer is inside the list column
 * (including the resize strip), so the main terminal area stays visually clean.
 */

/** Tailwind group name — must be a static string for JIT class detection. */
export const TERMINAL_SESSION_LIST_GROUP_CLASS = "group/terminal-session-list";

/** Wrapper around the resize handle + list column. */
export const TERMINAL_SESSION_LIST_OUTER_CLASS = `${TERMINAL_SESSION_LIST_GROUP_CLASS} flex h-full shrink-0`;

/**
 * className for VerticalResizeHandle (with variant="transparent"):
 * - Neutral divider when the pointer is anywhere in the list column
 * - Primary at 50% when the pointer is on the handle (overrides neutral via !)
 */
export const TERMINAL_SESSION_LIST_RESIZE_HANDLE_LINE_CLASS =
  "[&>div:first-child]:transition-colors [&>div:first-child]:duration-150 [&>div:first-child]:group-hover/terminal-session-list:bg-border-2 [&>div:first-child]:group-hover/resize:!bg-[color-mix(in_srgb,var(--color-primary-6)_50%,transparent)]";

/**
 * Apply to the outer column wrapper while dragging so solid primary wins over column-hover border.
 */
export const TERMINAL_SESSION_LIST_OUTER_RESIZING_LINE_CLASS =
  "[&>.resize-handle>div:first-child]:!bg-primary-6";

/** Settings preview has no resize handle — left border on the list column only. */
export const TERMINAL_SESSION_LIST_COLUMN_BORDER_HOVER_CLASS =
  "border-l border-transparent transition-colors duration-150 hover:border-border-2";
