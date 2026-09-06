import type { ShortcutEntry } from "./types";

export const BROWSER_SHORTCUTS: ShortcutEntry[] = [
  {
    id: "browser_new_tab",
    command: "New tab",
    macKeys: "⌘T",
    winKeys: "Ctrl+T",
    scope: "browser",
    category: "navigation",
  },
  {
    id: "browser_devtools",
    command: "Toggle DevTools panel",
    macKeys: "⌥⌘I",
    winKeys: "Alt+Ctrl+I",
    scope: "browser",
    category: "debugging",
  },
  {
    id: "browser_search",
    command: "Open command palette",
    macKeys: "⌘P",
    winKeys: "Ctrl+P",
    scope: "browser",
    category: "search",
  },
  {
    id: "browser_editor",
    command: "Switch to editor",
    macKeys: "⇧⌘E",
    winKeys: "Ctrl+Shift+E",
    scope: "browser",
    category: "view",
  },
];
