/**
 * Debounced Storage Adapter
 *
 * Custom storage adapter for `atomWithStorage` that debounces writes to
 * prevent localStorage from blocking the main thread.
 *
 * Storage layout (single key `workstation:layout-v2`):
 *
 *   {
 *     mainPane: { tabs: WorkStationTab[]; activeTabId: string | null },
 *   }
 *
 * Tauri-only app + clean-break upgrade from `workstation:layout-v1`
 * (which carried a split-pane tree and per-host pane buckets that no
 * longer exist). Old keys are ignored — the user's open-tab list will
 * reset once on first launch after the upgrade.
 */
import { createLogger } from "@src/hooks/logger";

import { FILE_TAB_TYPES, TOOL_TAB_TYPES } from "./types";
import type {
  PanelState,
  WorkStationLayoutState,
  WorkStationTab,
} from "./types";

const log = createLogger("workStationTabs");

export const LAYOUT_STORAGE_KEY = "workstation:layout-v2";

const VALID_WORKSTATION_TAB_TYPES = new Set<string>([
  ...FILE_TAB_TYPES,
  ...TOOL_TAB_TYPES,
]);

function isValidWorkStationTab(value: unknown): value is WorkStationTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<WorkStationTab>;
  return (
    typeof tab.id === "string" &&
    VALID_WORKSTATION_TAB_TYPES.has(String(tab.type))
  );
}

/**
 * Unified surface: there are no pinned / non-closable tabs. Normalize any
 * legacy fixture flags — Explorer / Source Control / Terminal used to persist
 * `pinned:true, closable:false, hideWhenOthersExist:true` — so every restored
 * tab is a regular, named, closable tab (and can reach the empty start page).
 */
function normalizeTab(tab: WorkStationTab): WorkStationTab {
  if (tab.pinned || tab.closable === false || tab.hideWhenOthersExist) {
    return {
      ...tab,
      pinned: false,
      closable: true,
      hideWhenOthersExist: false,
    };
  }
  return tab;
}

function validatePanelState(value: unknown): PanelState {
  if (!value || typeof value !== "object") {
    return { tabs: [], activeTabId: null };
  }
  const candidate = value as Record<string, unknown>;
  const tabs = Array.isArray(candidate.tabs)
    ? candidate.tabs.filter(isValidWorkStationTab).map(normalizeTab)
    : [];
  const activeTabId =
    typeof candidate.activeTabId === "string" &&
    tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : (tabs[0]?.id ?? null);
  return {
    tabs,
    activeTabId,
  };
}

/**
 * Creates a debounced localStorage storage adapter for `atomWithStorage`.
 *
 * PERFORMANCE: prevents synchronous localStorage writes from blocking the
 * main thread. Reads stay synchronous (needed for hydration); writes are
 * debounced.
 */
export function createDebouncedStorage<T>(delay = 100) {
  const pendingWrites = new Map<
    string,
    { value: T; timeoutId: ReturnType<typeof setTimeout> }
  >();

  return {
    getItem: (key: string, initialValue: T): T => {
      try {
        const stored = localStorage.getItem(key);
        if (!stored) return initialValue;

        const parsed = JSON.parse(stored);
        if (!parsed || typeof parsed !== "object" || !("mainPane" in parsed)) {
          return initialValue;
        }
        return {
          mainPane: validatePanelState(
            (parsed as Record<string, unknown>).mainPane
          ),
        } as T;
      } catch {
        return initialValue;
      }
    },
    setItem: (key: string, value: T): void => {
      const pending = pendingWrites.get(key);
      if (pending) clearTimeout(pending.timeoutId);

      const timeoutId = setTimeout(() => {
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch (err) {
          log.error(
            "[workStationTabs] Failed to persist to localStorage:",
            err
          );
        }
        pendingWrites.delete(key);
      }, delay);

      pendingWrites.set(key, { value, timeoutId });
    },
    removeItem: (key: string): void => {
      const pending = pendingWrites.get(key);
      if (pending) {
        clearTimeout(pending.timeoutId);
        pendingWrites.delete(key);
      }
      localStorage.removeItem(key);
    },
  };
}

export const debouncedLayoutStorage =
  createDebouncedStorage<WorkStationLayoutState>(100);
