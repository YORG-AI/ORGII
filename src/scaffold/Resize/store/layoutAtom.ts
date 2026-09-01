/**
 * Layout Atom - Jotai State Management for IDE Layout
 *
 * Centralized state for all resizable panel sizes.
 * Uses localStorage persistence to remember user preferences.
 *
 * Key principles:
 * - Only update state on resize END (not during)
 * - All layout state in one place
 * - Persist to localStorage for user preference
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { LayoutState, PanelSizes, SplitSizes } from "../types";

// ============================================
// Default Values
// ============================================

const DEFAULT_PANEL_SIZES: PanelSizes = {
  leftPanel: 280,
  rightPanel: 360,
  bottomPanel: 200,
};

const DEFAULT_SPLIT_SIZES: SplitSizes = {
  editorSplit: 50, // percentage
  simulatorSplit: 50,
};

const DEFAULT_LAYOUT_STATE: LayoutState = {
  panels: DEFAULT_PANEL_SIZES,
  splits: DEFAULT_SPLIT_SIZES,
};

// ============================================
// Main Layout Atom (with persistence)
// ============================================

/**
 * Main layout state atom with localStorage persistence
 */
const layoutAtom = atomWithStorage<LayoutState>(
  "ide-layout-v1",
  DEFAULT_LAYOUT_STATE
);

// ============================================
// Derived Atoms (for specific panels)
// ============================================

/**
 * Left panel width atom
 */
export const leftPanelWidthAtom = atom(
  (get) => get(layoutAtom).panels.leftPanel,
  (get, set, newWidth: number) => {
    const current = get(layoutAtom);
    set(layoutAtom, {
      ...current,
      panels: { ...current.panels, leftPanel: newWidth },
    });
  }
);
