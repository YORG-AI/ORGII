/**
 * Detail Panel & Wizard Tokens
 *
 * Shared tokens for list-detail panels and wizard flows:
 * - Integrations (Code Accounts, Channels)
 * - Memory Browser, ATC
 * - Dev Record, My Profile
 * - Wizards (KeyVaultWizard, ChannelWizard, etc.)
 *
 * Use CollapsibleSection for section headers and InfoCard for label/value blocks.
 */

// ============================================
// CollapsibleSection
// ============================================

export const COLLAPSIBLE_SECTION_TOKENS = {
  /** Wrapper margin between sections */
  wrapper: "mb-6",
  /** Header row (wraps title button + optional actions) — fixed 24px height */
  headerRow: "mb-3 flex h-6 items-center justify-between gap-2",
  /** Title button */
  titleButton:
    "flex items-center gap-1 text-[13px] font-semibold text-text-1 transition-colors hover:text-text-2",
  /** Chevron icon size */
  chevronSize: 14,
  /** Chevron icon color */
  chevronClass: "text-text-3",
  /** Vertical separator before actions (matches PanelHeader separator) */
  separator: "h-4 w-px bg-border-2",
  /** Icon-only action button props (matches PANEL_HEADER_TOKENS.actionButton) */
  actionButton: {
    variant: "tertiary" as const,
    size: "mini" as const,
    shape: "circle" as const,
    iconOnly: true as const,
    className: "hover:!bg-surface-selected",
  },
} as const;

// ============================================
// InfoCard
// ============================================

export const INFO_CARD_TOKENS = {
  /** Card container — rounded, fill background, no border (matches Settings table containers) */
  container: "rounded-lg bg-surface-selected p-4",
  /** Grid gap between rows */
  rowGap: "gap-3",
  /** Row layout */
  row: "flex items-center justify-between",
  /** Label typography */
  label: "text-[12px] text-text-2",
  /** Value typography (min-w-0 allows wrap in flex row) */
  value: "flex min-w-0 items-center gap-1 break-words text-[12px] text-text-1",
} as const;

// ============================================
// Detail Panel Layout
// ============================================

/** Standard 900px content / 932px padded-shell width used by detail surfaces. */
export const DETAIL_PANEL_WIDTH_TOKENS = {
  contentMaxWidth: "max-w-[900px]",
  contentWidth: "mx-auto w-full max-w-[900px]",
  contentWidthWithPadding: "mx-auto w-full max-w-[900px] py-4 pb-[50vh]",
  contentWidthWithPaddingNoTop: "mx-auto w-full max-w-[900px] pb-6 pb-[50vh]",
  headerWidth: "mx-auto w-full max-w-[932px]",
} as const;

/**
 * Narrow 800px content / 832px padded-shell width used by conversation
 * surfaces — chat transcript rows, the composer column, channel and
 * human-session messages. Same shape as `DETAIL_PANEL_WIDTH_TOKENS` so it
 * drops into the same slots; the shorter measure keeps prose lines readable.
 */
export const CHAT_PANEL_WIDTH_TOKENS = {
  contentMaxWidth: "max-w-[800px]",
  contentWidth: "mx-auto w-full max-w-[800px]",
  contentWidthWithPadding: "mx-auto w-full max-w-[800px] py-4 pb-[50vh]",
  contentWidthWithPaddingNoTop: "mx-auto w-full max-w-[800px] pb-6 pb-[50vh]",
  headerWidth: "mx-auto w-full max-w-[832px]",
} as const;

/** Wide 1200px content / 1232px padded-shell width reserved for issue surfaces. */
export const ISSUE_PANEL_WIDTH_TOKENS = {
  contentMaxWidth: "max-w-[1200px]",
  contentWidth: "mx-auto w-full max-w-[1200px]",
  contentWidthWithPadding: "mx-auto w-full max-w-[1200px] py-4 pb-[50vh]",
  contentWidthWithPaddingNoTop: "mx-auto w-full max-w-[1200px] pb-6 pb-[50vh]",
  headerWidth: "mx-auto w-full max-w-[1232px]",
} as const;

export const DETAIL_PANEL_TOKENS = {
  /** Outer container */
  container: "flex h-full flex-col",
  /**
   * Detail identity rows use a roomier left inset while actions stay compact.
   * The 7px trailing inset matches the shared workspace-header action grid.
   */
  headerPadding: "!pl-4 !pr-[7px]",
  /** Horizontal content inset (px-4) — shared by detail panels and wizards; no vertical padding so sticky headers can pin flush to the scrollport top */
  contentPadding: "px-4",
  /** Content bottom padding (pb-2) — reduced when footer follows */
  contentPaddingBottom: "pb-2",
  /**
   * Scrollable content area — wizard-matching format.
   * No padding on scroll container (clips at edge); use contentWidthWithPadding on inner.
   */
  scrollContent:
    "min-h-0 flex-1 overflow-y-auto px-4 scrollbar-overlay @container",
  /** Same as scrollContent — use contentWidthWithPaddingNoTop when header has no top padding */
  scrollContentNoTop:
    "min-h-0 flex-1 overflow-y-auto px-4 scrollbar-overlay @container",
  /** Standard gap between top-level blocks (stat grids, TabPill wrappers, hero cards, etc.) */
  sectionGap: "mb-6",
  /**
   * Vertical stack of rows/cards inside a section (InfoRow lists, script rows, connection rows).
   * Matches Integrations inline expanded cards: `gap-2` (8px).
   */
  contentStack: "flex flex-col gap-2",
  /** Info/summary card — wizard steps, config blocks */
  cardInfo: "rounded-lg bg-surface-selected px-4 py-3",
  /** Shared primary container surface used by settings and chat-panel content */
  primaryContainer:
    "rounded-xl border border-border-1 bg-primary-container p-4",
  ...DETAIL_PANEL_WIDTH_TOKENS,
  /**
   * Bottom inset on scrollable wizard / settings-style bodies so the last block
   * clears the footer (matches SETTINGS_MAIN_CONTENT_WRAPPER_CLASSES).
   */
  contentScrollBottom: "pb-6 pb-[50vh]",
} as const;

// ============================================
// Bordered Section (divider + collapsible section with equal spacing)
// ============================================

export const BORDERED_SECTION_TOKENS = {
  /** Wrapper — border-top divider with equal padding, neutralises CollapsibleSection mb */
  wrapper: "border-t border-border-2 pt-4 [&>*]:!mb-0",
  /** Bottom padding on the block above the first bordered section (matches CollapsibleSection py-3) */
  precedingBlock: "pb-3",
  /** Standalone line separator between sections */
  separator: "border-t border-border-2",
  /** Content wrapper inside CollapsibleSection — horizontal padding + strip trailing child margins */
  sectionContent: "px-4 [&>*:last-child]:!mb-0",
} as const;

// ============================================
// Stat Card Grid (Dev Record stat cards, responsive via container queries)
// ============================================

export const STAT_GRID_TOKENS = {
  /** 4-column grid: 2 cols narrow → 4 cols at 600px container width */
  cols4: "grid grid-cols-2 gap-3 @[600px]:grid-cols-4",
  /** 3-column grid: 2 cols narrow → 3 cols at 480px container width */
  cols3: "grid grid-cols-2 gap-3 @[480px]:grid-cols-3",
} as const;

// ============================================
// Card Row (compact card for relation rows, status bars, etc.)
// ============================================

export const CARD_ROW_TOKENS = {
  /** Compact card container — for relation rows, empty states, status bars */
  container: "rounded-lg bg-surface-selected p-3",
  /** Empty state placeholder */
  emptyState:
    "rounded-lg bg-surface-selected px-3 py-4 text-center text-sm text-text-3",
} as const;
