/**
 * Keyboard Hooks
 *
 * Centralized keyboard utilities for navigation, shortcuts, and input handling.
 */

// ============================================
// Hooks
// ============================================

export { useListNavigation } from "./useListNavigation";

export { useKeyboardSave } from "./useKeyboardSave";

export { useTauriSelectAllShortcut } from "./useTauriSelectAllShortcut";

export { useKeyboardMouseMode } from "./useKeyboardMouseMode";

// ============================================
// Shortcut Registry (runtime event matching)
// ============================================

export { shortcutRegistry } from "@src/config/keyboard/ShortcutRegistry";

// ============================================
// Shortcut Display (centralized lookup)
// ============================================

export {
  getShortcutKeys,
  getShortcutEntry,
  getShortcutAccelerator,
  labelWithShortcut,
  isModifierPressed,
  matchesKey,
} from "@src/config/keyboard/shortcutDisplay";
