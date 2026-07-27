/**
 * recentCliAgentsAtom
 *
 * Persists up to MAX_RECENT CLI agent types that the user has explicitly
 * launched from the chat panel + menu. Used to surface the most recently
 * used agents at the top of the + dropdown.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";

const MAX_RECENT = 3;
const STORAGE_KEY = "orgii:recentChatCliAgents";

/** Ordered list of recently used CLI agent types (most recent first, max 3). */
export const recentCliAgentsAtom = atomWithStorage<CliAgentType[]>(
  STORAGE_KEY,
  [],
  {
    getItem: (key, initialValue) => {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return initialValue;
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) return parsed as CliAgentType[];
      } catch {
        // Corrupt storage — start empty
      }
      return initialValue;
    },
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // localStorage may be unavailable
      }
    },
    removeItem: (key) => {
      localStorage.removeItem(key);
    },
  }
);

/**
 * Write-only atom: records that the user just launched a given CLI agent.
 * Moves the agent to front; evicts the oldest beyond MAX_RECENT.
 */
export const recordRecentCliAgentAtom = atom(
  null,
  (_get, set, agentType: CliAgentType) => {
    set(recentCliAgentsAtom, (prev) => {
      const without = prev.filter((type) => type !== agentType);
      return [agentType, ...without].slice(0, MAX_RECENT);
    });
  }
);
recordRecentCliAgentAtom.debugLabel = "recordRecentCliAgent";

/**
 * Signal atom: when set to a non-null CliAgentType, the next new session tab
 * will pre-select that CLI agent in the session creator, then reset to null.
 */
export const pendingCliAgentAtom = atom<CliAgentType | null>(null);
pendingCliAgentAtom.debugLabel = "pendingCliAgent";
