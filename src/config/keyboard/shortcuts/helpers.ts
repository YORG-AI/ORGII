import { ALL_SHORTCUTS } from "./allShortcuts";
import { CATEGORY_CONFIG } from "./displayConfig";
import type { ShortcutCategory } from "./types";

export function getCategories(): ShortcutCategory[] {
  const categories = [
    ...new Set(ALL_SHORTCUTS.map((shortcut) => shortcut.category)),
  ];
  return categories.sort(
    (catA, catB) =>
      (CATEGORY_CONFIG[catA]?.order ?? 99) -
      (CATEGORY_CONFIG[catB]?.order ?? 99)
  );
}
