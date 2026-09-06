/**
 * Tab history can contain every closed surface, while the Recent section in
 * the new-tab menus is reserved for user-specific context that cannot already
 * be reopened from an action immediately above it.
 */
const RECENT_MENU_TAB_TYPES = new Set([
  "file",
  "directory",
  "chat-session",
  "session",
]);

interface TabWithType {
  type: string;
}

export function shouldShowInRecentTabsMenu(tab: TabWithType): boolean {
  return RECENT_MENU_TAB_TYPES.has(tab.type);
}
