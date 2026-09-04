/**
 * Pinned Actions atom
 *
 * Persists the user's pinned quick-action items to localStorage so they
 * survive app restarts. Each entry holds the stable identity and dispatch
 * fields needed by both the optional quick-action bar and the `/` menu.
 *
 * Storage key: `orgii:pinnedActions`
 */
import { atomWithStorage } from "jotai/utils";

import type { SlashItem } from "@src/types/extensions";

/** A pinned action — a minimal snapshot of the slash item's identity. */
export interface PinnedAction {
  /** Last-known display label. */
  name: string;
  /** Skill name used as the slash-command token (skills only). */
  skillName?: string;
  /** Absolute path to the skill directory when available. */
  skillPath?: string;
  /** Item category — determines how it is dispatched when clicked. */
  category: SlashItem["category"];
  /** The source group (builtin / skill source / MCP server name). */
  source: string;
  /** For tool items: the MCP server name. */
  serverName?: string;
}

/**
 * Stable identity shared by every surface that projects or manages pins.
 *
 * A skill's backend token survives display-group changes, while MCP tools
 * need both their server and tool names to remain unique. Keeping this next
 * to the persisted model prevents the hidden bar and the `/` menu from
 * drifting into separate pin systems.
 */
export function getPinnedActionKey(action: PinnedAction | SlashItem): string {
  if (action.category === "skill") {
    return `skill|${action.skillName ?? action.name}`;
  }
  if (action.category === "tool") {
    return `tool|${action.serverName ?? action.source}|${action.name}`;
  }
  return `${action.category}|${action.name}`;
}

/** Snapshot the stable fields needed to persist a slash item as a pin. */
export function slashItemToPinnedAction(item: SlashItem): PinnedAction {
  return {
    name: item.name,
    skillName: item.skillName,
    skillPath: item.skillPath,
    category: item.category,
    source: item.source,
    serverName: item.serverName,
  };
}

const DEFAULT_PINNED: PinnedAction[] = [];

const STORAGE_KEY = "orgii:pinnedActions";

/**
 * Remove legacy entries that are no longer valid.
 * Currently removes: `{name: "setup-repo", category: "skill"}` — this was
 * pinned automatically in old builds but is now superseded by the
 * `Setup Repo` built-in action pill.
 */
function migrate(actions: PinnedAction[]): PinnedAction[] {
  return actions.filter(
    (a) => !(a.category === "skill" && a.name === "setup-repo")
  );
}

const storage = {
  getItem(key: string, initialValue: PinnedAction[]): PinnedAction[] {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      const parsed = JSON.parse(stored) as unknown;
      if (!Array.isArray(parsed)) return initialValue;
      return migrate(parsed as PinnedAction[]);
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: PinnedAction[]) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

export const pinnedActionsAtom = atomWithStorage<PinnedAction[]>(
  STORAGE_KEY,
  DEFAULT_PINNED,
  storage
);
