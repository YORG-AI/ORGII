/**
 * Event Block Configuration
 *
 * Shared Tailwind classes and constants for session event blocks (chat, simulator, replay).
 *
 * SPACING SYSTEM:
 * All chat items in the ChatPanel use a unified spacing system.
 * Spacing is controlled at two levels:
 *
 * 1. **Item-level** (ChatItemRenderer wrapper):
 *    - Horizontal padding: `px-3` (12px) for all items
 *    - Vertical gap: `CHAT_ITEM_GAP` between items (1px each side = 2px total)
 *
 * 2. **Block-level** (individual block components):
 *    - Blocks themselves have NO outer margin/padding
 *    - Internal padding is handled by block content areas
 *
 * This separation ensures consistent spacing regardless of
 * block type or collapsed/expanded state.
 */

// ============================================
// SESSION UI DESIGN TOKENS
// ============================================

/**
 * Centralized design tokens for Session UI components.
 * All event and block components should reference these tokens
 * instead of hardcoded values.
 *
 * Token naming convention:
 * - FONT_SIZE: Typography size tokens
 * - TEXT: Text styling classes (includes color)
 * - STATUS: Status-specific styling
 * - BADGE: Badge/chip styling
 * - CARD: Card container styling
 * - SPACING: Padding/margin tokens
 */
export const SESSION_UI_TOKENS = {
  // ============================================
  // Font Size Tokens — all derived from --chat-font-size via CSS classes
  // ============================================
  /** XS: base - 3px — Labels, badges, secondary info, section headers */
  FONT_SIZE_XS: "chat-block-xs",
  /** SM: code-font-size — Descriptions, subtitles, metadata */
  FONT_SIZE_SM: "chat-block-content",
  /** BASE: base - 1px — Block titles, content, primary labels */
  FONT_SIZE_BASE: "chat-block-title",
  /** MD: base — Headings, user messages, prominent text */
  FONT_SIZE_MD: "chat-block-md",

  // ============================================
  // Status Badge Tokens
  // ============================================
  STATUS_BADGE: {
    /** Success/running status */
    SUCCESS:
      "rounded bg-success-6/10 px-1.5 py-0.5 chat-block-xs font-bold text-success-6",
    /** Warning/background status */
    WARNING:
      "rounded bg-warning-6/10 px-1.5 py-0.5 chat-block-xs font-bold text-warning-6",
    /** Danger/error/failed status */
    DANGER:
      "rounded bg-danger-6/10 px-1.5 py-0.5 chat-block-xs font-bold text-danger-6",
    /** Primary/info status */
    PRIMARY:
      "rounded bg-primary-6/10 px-1.5 py-0.5 chat-block-xs font-bold text-primary-6",
    /** Neutral status */
    NEUTRAL:
      "rounded bg-fill-3 px-1.5 py-0.5 chat-block-xs font-bold text-text-3",
  },

  // ============================================
  // Event Card Tokens
  // ============================================
  EVENT_CARD: {
    /** Standard event card with border and background */
    DEFAULT:
      "flex flex-col gap-2 overflow-hidden rounded-lg border border-border-1 bg-event-block p-3",
    /** Card variant with colored backgrounds */
    SUCCESS:
      "rounded-xl border border-success-6/20 bg-success-6/5 overflow-hidden",
    DANGER: "rounded-lg bg-danger-6/10 p-3",
    PRIMARY: "rounded-lg bg-primary-6/10 border-l-2 border-primary-6 px-4 py-3",
    /** Transparent card - no background */
    TRANSPARENT: "rounded-lg overflow-hidden",
  },

  // ============================================
  // Text Style Tokens
  // ============================================
  TEXT: {
    // Primary text styles
    PRIMARY: "text-text-1",
    SECONDARY: "text-text-2",
    TERTIARY: "text-text-3",
    QUATERNARY: "text-text-4",

    // Semantic text styles
    ERROR: "text-danger-6",
    SUCCESS: "text-success-6",
    WARNING: "text-warning-6",
    INFO: "text-primary-6",

    // Text with font-size combinations
    TITLE_MD: "chat-block-md font-semibold text-text-1",
    TITLE_BASE: "chat-block-title font-medium text-text-1",
    BODY_BASE: "chat-block-title leading-relaxed text-text-1",
    BODY_SM: "chat-block-content leading-relaxed text-text-2",
    LABEL_XS: "chat-block-xs font-bold uppercase tracking-[0.12em] text-text-3",
    LABEL_SUCCESS:
      "chat-block-xs font-bold uppercase tracking-[0.12em] text-success-6",
    DESCRIPTION_SM: "chat-block-content text-text-2",
    DESCRIPTION_XS: "chat-block-xs text-text-3",
  },

  // ============================================
  // Section Header Tokens
  // ============================================
  SECTION_HEADER: {
    /** Default section header */
    DEFAULT: "flex select-none items-center gap-2 mb-3",
    /** Card-style section header */
    CARD: "flex select-none items-center gap-2.5 px-4 py-2.5 border-b border-border-1 bg-event-block/80",
    /** Thinking section header */
    THINKING:
      "flex select-none items-center gap-2.5 px-4 py-2.5 border-b border-success-6/20 bg-success-6/5",
    /** Inline tool label */
    INLINE:
      "bg-event-block px-4 py-2 chat-block-xs font-bold uppercase text-text-3",
  },

  // ============================================
  // Row Layout Tokens
  // ============================================
  ROW: {
    /** Standard inline event row — matches EventBlockHeader dimensions */
    INLINE: "chat-block-header flex items-center gap-2 h-[36px] px-2",
    /** File list item row — inherits --chat-block-title-size via .chat-block-header */
    FILE_ITEM:
      "flex items-center gap-2 rounded-lg bg-event-block px-3 py-2 transition-colors",
    /** Loading row with spinner */
    LOADING: "flex items-center gap-2 p-4",
    /** Empty/no content row — inherits --chat-block-title-size via .chat-block-header */
    EMPTY: "p-4 text-text-3",
  },

  // ============================================
  // Code/Pre Content Tokens
  // ============================================
  CODE: {
    /** Inline code snippet — uses --chat-block-content-size */
    INLINE: "chat-block-content rounded bg-event-block px-2 py-1 text-text-1",
    /** Code block container — uses --chat-block-content-size */
    BLOCK: "chat-block-content overflow-auto p-4 leading-relaxed text-text-1",
    /** Pre-formatted content */
    PRE_DEFAULT: "whitespace-pre-wrap text-text-2",
    PRE_ERROR:
      "rounded bg-fill-3 p-2 chat-block-xs leading-relaxed text-text-3",
    PRE_DANGER: "rounded bg-danger-6/5 p-2 chat-block-xs text-danger-6/80",
  },

  // ============================================
  // Action Button Tokens
  // ============================================
  BUTTON: {
    /** Stop/cancel button */
    DANGER:
      "rounded bg-danger-6/10 px-2 py-0.5 chat-block-xs font-bold text-danger-6 transition-colors hover:bg-danger-6/20 disabled:opacity-50",
  },

  // ============================================
  // Icon Tokens
  // ============================================
  ICON: {
    /** Size values */
    SIZE_XS: 12,
    SIZE_SM: 14,
    SIZE_MD: 16,
    SIZE_LG: 20,
    /** Icon classes */
    DEFAULT: "text-text-2",
    MUTED: "text-text-3",
    ERROR: "text-danger-6",
    SUCCESS: "text-success-6",
    PRIMARY: "text-primary-6",
  },
} as const;

// ============================================
// Helper Functions for Token Classes
// ============================================

/**
 * Get status badge classes by status type
 */
export function getStatusBadgeClass(
  status: "success" | "warning" | "danger" | "primary" | "neutral"
): string {
  return SESSION_UI_TOKENS.STATUS_BADGE[
    status.toUpperCase() as keyof typeof SESSION_UI_TOKENS.STATUS_BADGE
  ];
}

/**
 * Get event card classes by variant
 */
export function getEventCardClass(
  variant: "default" | "success" | "danger" | "primary" | "transparent"
): string {
  return SESSION_UI_TOKENS.EVENT_CARD[
    variant.toUpperCase() as keyof typeof SESSION_UI_TOKENS.EVENT_CARD
  ];
}

// ============================================
// Chat Item Spacing Tokens
// ============================================

/** Gap between chat items (Tailwind class) — 2px each side = 4px total gap between items */
export const CHAT_ITEM_GAP = "py-1";

/** Horizontal padding for chat items (Tailwind class) */
export const CHAT_ITEM_PADDING_X = "px-2";

/** Horizontal padding for text-based items like assistant messages (Tailwind class)
 * Aligned with tool blocks (px-2) for consistent left edge across all chat items */
export const CHAT_ITEM_TEXT_PADDING_X = "px-2";

/**
 * Inner padding for chat monospace snippets (terminal command row, BlockOutput).
 * Matches `.terminal-command--chat` in TerminalDisplay/index.scss: 12px × 10px.
 */
export const EVENT_SNIPPET_INNER_PADDING_CLASS = "px-3 py-1.5";

// ============================================
// Event Block Surface Tokens
// ============================================

export const EVENT_BLOCK_CONTENT_BG = "bg-event-block";
export const EVENT_BLOCK_BORDER_CLASSES = "border border-border-1";
export const EVENT_BLOCK_FADE_FROM = "from-event-block-fade";

// ============================================
// Standard Container Classes
// ============================================

/**
 * Get standard container classes for event blocks
 * @param withBackground - Whether to add EVENT_BLOCK_CONTENT_BG background and border. Set false for blocks like Thinking
 * @returns className string
 */
export const getEventBlockContainerClasses = (withBackground = true) =>
  `w-full max-w-full overflow-hidden rounded-lg transition-all duration-200 ${
    withBackground
      ? `${EVENT_BLOCK_BORDER_CLASSES} ${EVENT_BLOCK_CONTENT_BG}`
      : ""
  }`.trim();

// ============================================
// Standard Header Classes
// ============================================

/**
 * Standard header height (in pixels)
 */
export const EVENT_BLOCK_HEADER_HEIGHT = 36; // Fixed 36px height

/**
 * Get standard header classes for event blocks
 * @param isCollapsed - Whether the block is collapsed
 * @param withHover - Whether to show hover effect and border (default: true). Set false for transparent blocks
 * @param clickable - Whether the header responds to clicks (default: true). Controls cursor style
 * @returns className string
 * Note: No background - inherits from container. No hover/border for transparent blocks.
 * Border-b uses border-transparent when collapsed to prevent 1px shift on collapse/expand
 * Font size is inherited from parent which uses --chat-font-size CSS variable
 */
export const getEventBlockHeaderClasses = (
  isCollapsed: boolean,
  _withHover = true,
  clickable = true
) =>
  `chat-block-header flex ${clickable ? "cursor-pointer" : "cursor-default"} items-center justify-between px-2 h-[36px] transition-all duration-150`;

/**
 * Standard header left section classes
 */
export const EVENT_BLOCK_HEADER_LEFT_CLASSES =
  "flex min-w-0 flex-1 items-center gap-2";

/**
 * Standard header right section classes
 */
export const EVENT_BLOCK_HEADER_RIGHT_CLASSES =
  "flex flex-shrink-0 items-center gap-0.5";

// ============================================
// Header Button Classes
// ============================================

/**
 * Simple copy button classes (14px icon, no wrapper, always visible)
 * @param _isVisible - Deprecated: buttons are now always visible
 * @returns className string
 */
export const getEventBlockCopyButtonClasses = (_isVisible: boolean) =>
  `cursor-pointer text-text-3 transition-all duration-150 hover:text-text-1 opacity-100`;

// ============================================
// Expand Button Classes
// ============================================

/**
 * Standard expand/collapse button classes (Show more/less)
 * Note: No background hover, only text color change from text-3 to text-1
 */
export const EVENT_BLOCK_EXPAND_BUTTON_CLASSES =
  "flex cursor-pointer select-none items-center justify-center gap-1.5 px-3 pb-1.5 chat-block-xs text-text-2 transition-colors duration-150 hover:text-text-1";

// ============================================
// Background Tokens (fill hierarchy)
// ============================================

/**
 * Fill-2 panel below a transparent block header (glob, ls, tool output, terminal, code terminal layout).
 * Shared rounded shell — use so expanded body matches CodeBlock / Explore, not a square fill on the outer `rounded-lg` clip.
 */
export const EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES = `mt-1 overflow-hidden rounded-lg ${EVENT_BLOCK_BORDER_CLASSES} ${EVENT_BLOCK_CONTENT_BG}`;

/**
 * CSS variable equivalent of EVENT_BLOCK_CONTENT_BG for inline styles.
 * Use when Tailwind classes aren't applicable (e.g. virtualised list style prop).
 */
export const EVENT_BLOCK_CONTENT_BG_VAR = "var(--color-event-block)";

/**
 * Elevated surface background — one step above EVENT_BLOCK_CONTENT_BG.
 * Used for badges, chips, and elements that need contrast against fill-2 content.
 */
export const EVENT_BLOCK_ELEVATED_BG = "bg-fill-3";

// ============================================
// Icon Classes
// ============================================

/**
 * Standard icon wrapper classes
 * Uses CSS class for variable-based sizing
 */
export const EVENT_BLOCK_ICON_WRAPPER_CLASSES =
  "chat-block-icon inline-flex h-[14px] w-[14px] flex-shrink-0 select-none items-center justify-center self-center text-text-2";

/**
 * Larger hover target around the icon for chevron reveal.
 * Wraps the icon wrapper to provide a comfortable click/hover zone
 * while keeping the visual icon size at 14×14.
 */
export const EVENT_BLOCK_ICON_HOVER_AREA_CLASSES =
  "inline-flex select-none items-center justify-center p-1 -m-1 rounded-sm";

/**
 * Standard icon classes
 */
export const EVENT_BLOCK_ICON_CLASSES =
  "chat-block-icon flex-shrink-0 text-text-2";

// ============================================
// Text Classes
// ============================================

/**
 * Gradient shimmer for label / detail text while a chat block is in progress.
 * Use only when `isLoading` or `isStreaming` is true; pairs with spinning
 * EventBlockHeaderIcon or inline Loader2.
 */
export const EVENT_LOADING_SHIMMER_TEXT_CLASSES =
  "bg-gradient-to-r from-text-3 via-text-1 to-text-3 bg-[length:260%_100%] bg-clip-text text-transparent animate-shimmer-text";

/**
 * Standard title classes
 * Font size is inherited from header which uses --chat-font-size CSS variable
 */
export const EVENT_BLOCK_TITLE_CLASSES =
  "overflow-hidden text-ellipsis whitespace-nowrap font-medium text-text-1";

/**
 * Standard badge classes (char count, etc.)
 */
export const EVENT_BLOCK_BADGE_CLASSES =
  "flex-shrink-0 chat-block-xs font-medium text-text-3";

/**
 * Standard badge with background classes (execution time, exit code, etc.)
 */
export const EVENT_BLOCK_BADGE_BG_CLASSES = `flex-shrink-0 rounded ${EVENT_BLOCK_ELEVATED_BG} px-1.5 py-0.5 chat-block-xs font-medium text-text-3`;

// ============================================
// Content Classes
// ============================================

/**
 * Standard content wrapper classes
 */
export const EVENT_BLOCK_CONTENT_CLASSES = "overflow-hidden";

/**
 * Get standard content area classes for event blocks
 * @param options - Configuration options
 * @param options.padding - Custom padding classes (default: "p-2.5")
 * @param options.maxHeight - Optional max height classes (e.g., "max-h-[150px]")
 * @param options.overflow - Overflow behavior (default: "overflow-auto" if maxHeight, else undefined)
 * @returns className string
 * Note: No background — inherits EVENT_BLOCK_CONTENT_BG from container
 */
export const getEventBlockContentClasses = ({
  padding = "p-2.5",
  maxHeight,
  overflow,
}: {
  padding?: string;
  maxHeight?: string;
  overflow?: string;
} = {}) => {
  const classes = [
    padding,
    maxHeight,
    overflow || (maxHeight ? "overflow-auto" : ""),
  ];
  return classes.filter(Boolean).join(" ");
};

/**
 * Get standard expanded content container classes for transparent blocks
 * Used for nested content within transparent blocks (Search, Ls, etc.)
 * @param options - Configuration options
 * @param options.padding - Custom padding classes (default: "p-2.5")
 * @param options.maxHeight - Optional max height classes (e.g., "max-h-[200px]")
 * @returns className string
 */
export const getEventBlockExpandedContainer = ({
  padding = "p-2.5",
  maxHeight,
}: {
  padding?: string;
  maxHeight?: string;
} = {}) => {
  const classes = [
    "mt-1",
    "rounded-lg",
    EVENT_BLOCK_CONTENT_BG,
    padding,
    maxHeight,
    maxHeight ? "overflow-auto" : "",
  ];
  return classes.filter(Boolean).join(" ");
};

// ============================================
// Constants
// ============================================

/**
 * Default number of visible lines before "Show more"
 */
export const DEFAULT_VISIBLE_LINES = 15;

/**
 * Icon sizes
 */
export const ICON_SIZES = {
  compact: 12,
  standard: 14,
  prominent: 16,
} as const;
