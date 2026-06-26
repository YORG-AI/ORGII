/**
 * Shortcut Display Utilities
 *
 * Platform-aware lookup for shortcut display strings.
 * All UI code should use these functions instead of hardcoding "⌘J" / "Ctrl+J".
 */
import { ALL_SHORTCUTS, type ShortcutEntry } from "./shortcuts";

const IS_MAC =
  typeof navigator !== "undefined" &&
  navigator.platform.toUpperCase().indexOf("MAC") >= 0;

const shortcutMap = new Map<string, ShortcutEntry>();
for (const entry of ALL_SHORTCUTS) {
  shortcutMap.set(entry.id, entry);
}

interface ShortcutDisplayOptions {
  chatSendOnEnter?: boolean;
}

/** Get platform-appropriate display string for a shortcut by ID. */
export function getShortcutKeys(
  id: string,
  options?: ShortcutDisplayOptions
): string {
  if (id === "chat_send" && options?.chatSendOnEnter) return "Enter";
  const entry = shortcutMap.get(id);
  if (!entry) return "";
  return IS_MAC ? entry.macKeys : entry.winKeys;
}

/** Get the full ShortcutEntry by ID. */
export function getShortcutEntry(id: string): ShortcutEntry | undefined {
  return shortcutMap.get(id);
}

/** Build a display label like "Search (⌘⇧P)" from a label and shortcut ID. */
export function labelWithShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId);
  return keys ? `${label} (${keys})` : label;
}

/**
 * Check if modifier key is pressed based on platform.
 * On Mac, checks metaKey; on other platforms, checks ctrlKey.
 */
export function isModifierPressed(event: KeyboardEvent): boolean {
  return IS_MAC ? event.metaKey : event.ctrlKey;
}

/**
 * Check if event matches a shortcut key (case-insensitive).
 * Optionally requires the platform modifier (Cmd on Mac, Ctrl elsewhere).
 */
export function matchesKey(
  event: KeyboardEvent,
  key: string,
  requireModifier = false
): boolean {
  if (requireModifier && !isModifierPressed(event)) {
    return false;
  }
  return event.key.toLowerCase() === key.toLowerCase();
}
