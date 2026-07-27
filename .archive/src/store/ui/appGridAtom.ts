/**
 * App Grid State Management
 *
 * Stores user customization for the home page app grid:
 * - Custom app order (via drag-and-drop)
 * - Gap sizes (horizontal and vertical)
 */
import { APP_GRID_ITEMS } from "@/src/modules/MainApp/StartPage/components/AppGrid/config";
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// ============================================
// Types
// ============================================

export interface AppGridConfig {
  /** Ordered array of app IDs (user can reorder via drag) */
  appOrder: string[];
  /** Horizontal gap in pixels */
  horizontalGap: number;
  /** Vertical gap in pixels */
  verticalGap: number;
}

// ============================================
// Default Configuration
// ============================================

export const DEFAULT_APP_GRID_CONFIG: AppGridConfig = {
  appOrder: APP_GRID_ITEMS.map((app) => app.id),
  horizontalGap: 56,
  verticalGap: 36,
};

// ============================================
// Atom
// ============================================

/**
 * Persisted app grid configuration
 */
const appGridStorage = {
  getItem: (key: string, initial: AppGridConfig): AppGridConfig => {
    const stored = localStorage.getItem(key);
    if (!stored) return initial;
    try {
      return JSON.parse(stored) as AppGridConfig;
    } catch {
      return initial;
    }
  },
  setItem: (key: string, value: AppGridConfig) => {
    localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key);
  },
};

export const appGridConfigAtom = atomWithStorage<AppGridConfig>(
  "orgii_app_grid_config",
  DEFAULT_APP_GRID_CONFIG,
  appGridStorage
);
appGridConfigAtom.debugLabel = "appGridConfigAtom";

/**
 * Edit mode atom (whether user is currently customizing the grid)
 */
export const appGridEditModeAtom = atom<boolean>(false);
appGridEditModeAtom.debugLabel = "appGridEditModeAtom";

// ============================================
// Helper Atoms
// ============================================

/**
 * Reset app grid to default configuration
 */
export const resetAppGridAtom = atom(null, (_get, set) => {
  set(appGridConfigAtom, DEFAULT_APP_GRID_CONFIG);
});
resetAppGridAtom.debugLabel = "resetAppGridAtom";
