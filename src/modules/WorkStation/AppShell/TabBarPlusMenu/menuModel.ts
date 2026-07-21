const TAB_BAR_PLUS_MENU_ITEMS = [
  "searchFile",
  "newBrowserTab",
  "newPrivateBrowserTab",
  "workItems",
  "projects",
] as const;

export type TabBarPlusMenuItem = (typeof TAB_BAR_PLUS_MENU_ITEMS)[number];

export const DEFAULT_TAB_BAR_PLUS_MENU_ITEMS: readonly TabBarPlusMenuItem[] =
  TAB_BAR_PLUS_MENU_ITEMS;

const KNOWN_ITEMS = new Set<string>(TAB_BAR_PLUS_MENU_ITEMS);

export function getVisibleTabBarPlusMenuItems(
  items: readonly string[]
): TabBarPlusMenuItem[] {
  return items.filter((item): item is TabBarPlusMenuItem =>
    KNOWN_ITEMS.has(item)
  );
}
