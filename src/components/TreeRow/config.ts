/**
 * Shared configuration for tree row components
 */
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

/** Height of each tree row in pixels */
export const TREE_ROW_HEIGHT = 28;

/** Indentation per depth level in pixels */
export const TREE_INDENT_PX = 8;

/** Base horizontal padding in pixels (16px = pl-4) */
export const TREE_PADDING_X = 16;

/** Horizontal row inset in pixels (4px = mx-1). */
export const TREE_ROW_INSET_X = 4;

/** Trailing content inset measured from the sidebar edge. */
export const TREE_PADDING_RIGHT = 8;

/** Shared inset class for tree rows. */
export const TREE_ROW_INSET_CLASS = "mx-1";

/** Shared corner radius for independently highlighted tree rows. */
export const TREE_ROW_ROUNDED_CLASS = "rounded-md";

/** Icon size for chevrons */
export const CHEVRON_SIZE = 14;

/** Icon size for file type icons */
export const FILE_ICON_SIZE = "small" as const;

/** Status badge width for consistent alignment */
export const STATUS_BADGE_WIDTH = 20; // w-5 = 1.25rem = 20px

/** Shared hover background for tree rows and tree row actions. */
export const TREE_ROW_HOVER_BG_CLASS = SURFACE_TOKENS.hover;

/** Shared vertical indent guide style for sidebar tree rows. */
export const TREE_INDENT_GUIDE_CLASS =
  "tree-indent-guide pointer-events-none absolute bottom-0 top-0 w-px bg-border-2/70";

/**
 * Horizontal offset (px) from the row's left edge to the indent guide
 * at depth 0.  Left-aligned with the chevron (3px inset from left edge).
 *
 *   guideX(level) = TREE_GUIDE_OFFSET_BASE + level * TREE_INDENT_PX
 */
export const TREE_GUIDE_OFFSET_BASE = TREE_PADDING_X + 3; // 19
