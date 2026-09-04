// Shortcut Display Utilities (primary API for UI consumers)
export {
  getShortcutEntry,
  getShortcutKeys,
  isModifierPressed,
  labelWithShortcut,
  matchesKey,
} from "./shortcutDisplay";

// Shortcut Data Catalog
export {
  ALL_SHORTCUTS,
  CATEGORY_CONFIG,
  SCOPE_LABELS,
  getCategories,
  getScopes,
  getShortcutsByCategory,
  getShortcutsByScope,
  type ShortcutCategory,
  type ShortcutEntry,
  type ShortcutScope,
} from "./shortcuts";

// Runtime Shortcut Registry (event matching, dispatching)
export {
  SHORTCUT_DEFINITIONS,
  shortcutRegistry,
  type Modifier,
  type ShortcutCategory as RegistryShortcutCategory,
  type ShortcutDefinition,
  type ShortcutRegistryClass,
  type ShortcutScope as RegistryShortcutScope,
} from "./ShortcutRegistry";
