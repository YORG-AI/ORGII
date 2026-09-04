/**
 * Search Result Selection Atom
 *
 * PERFORMANCE: Uses Jotai atom for selection state instead of component state.
 * This means only the previously-selected and newly-selected items re-render
 * when selection changes, instead of ALL items re-rendering.
 *
 * Pattern copied from fileTreeSelectionAtom.ts
 */
import { atom, useAtomValue } from "jotai";

// ============================================
// Selection State Atom
// ============================================

/**
 * Selected search result key (e.g., "match:/path/file.ts:3" or "file:/path/file.ts")
 */
export const searchResultSelectedKeyAtom = atom<string | null>(null);

// ============================================
// Selection Hook
// ============================================

/**
 * Hook to check if a specific search result is selected.
 * Only re-renders when THIS item's selection state changes.
 *
 * @param key - The unique key for this item (e.g., "match:/path:3" or "file:/path")
 */
export function useIsSearchResultSelected(key: string): boolean {
  const selectedKey = useAtomValue(searchResultSelectedKeyAtom);
  return selectedKey === key;
}
