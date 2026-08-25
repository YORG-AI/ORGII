/**
 * Configuration for Tab Bar
 *
 * Shared by: ChatPanel, CodeEditor, DatabaseManager, Browser, SessionReplay
 */

/** Height of the tab bar in pixels */
export const TAB_BAR_HEIGHT = 36;

/**
 * Fixed 1×16px rule with 2px side margins between every pair of tab pills
 * (always rendered), providing 4px of clear space while keeping the divider
 * itself crisp. Apply `bg-border-2` when both neighbors are inactive,
 * otherwise `bg-transparent`.
 */
export const TAB_PAIR_SEPARATOR_SLOT_CLASS =
  "pointer-events-none mx-0.5 h-4 w-px shrink-0 self-center";

/**
 * Rule between the optional tab-row prefix (e.g. Control Tower groups) and
 * sortable workstation tabs — stronger than inactive tab-pair separators.
 */
export const TAB_STRIP_SECTION_RULE_CLASS =
  "pointer-events-none mx-1.5 shrink-0 self-center h-5 w-px bg-border-2";

/** Maximum number of tabs to display before showing overflow */
export const MAX_VISIBLE_TABS = 10;

/** Status badge labels */
export const STATUS_LABELS: Record<string, string> = {
  modified: "M",
  deleted: "D",
  added: "A",
  renamed: "R",
};
