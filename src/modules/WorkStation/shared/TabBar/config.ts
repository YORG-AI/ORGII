/**
 * Configuration for Tab Bar
 *
 * Shared by: ChatPanel, CodeEditor, DatabaseManager, Browser, SessionReplay
 */

/** Height of the tab bar in pixels */
export const TAB_BAR_HEIGHT = 36;

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
