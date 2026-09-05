/**
 * Session-only per-tab view state.
 *
 * WorkStation content hosts mount only the active tab (`EditorMainPane`
 * renders `UnifiedTabContent` for `activeTab` alone). Leaving a tab unmounts
 * its subtree and coming back rebuilds it from tab data plus stores — there
 * is deliberately no hidden DOM tree kept warm behind `display:none`. Tab
 * data is persisted to localStorage and is the wrong home for ephemeral
 * view state (expanded diff sections, a list's scroll offset, a detail
 * sub-tab selection), so that state lives here instead:
 *
 *   - keyed by tab id, one slot map per tab;
 *   - in memory only — it never reaches localStorage;
 *   - dropped when the tab closes (the close mutations in `tabMutations.ts`
 *     call `deleteTabViewState`), and LRU-bounded so a long session cannot
 *     accumulate it for tabs that were never closed.
 *
 * Components read a slot once at mount and write it on change; see
 * `@src/hooks/tabHost/useTabViewState` for the `useState`-shaped wrapper.
 */
import { BoundedMap } from "@src/util/collections/BoundedMap";

/** Tabs whose view state stays resident at once. */
export const MAX_TAB_VIEW_STATE_TABS = 128;

type TabViewStateSlots = Map<string, unknown>;

const tabViewStates = new BoundedMap<string, TabViewStateSlots>({
  maxSize: MAX_TAB_VIEW_STATE_TABS,
  name: "tabViewState",
});

/** Read one slot of a tab's view state; `undefined` when nothing was saved. */
export function getTabViewState<T>(tabId: string, slot: string): T | undefined {
  if (!tabId) return undefined;
  return tabViewStates.get(tabId)?.get(slot) as T | undefined;
}

/** Save one slot of a tab's view state. Empty tab ids are ignored. */
export function setTabViewState<T>(
  tabId: string,
  slot: string,
  value: T
): void {
  if (!tabId) return;
  const slots = tabViewStates.get(tabId);
  if (slots) {
    slots.set(slot, value);
    return;
  }
  tabViewStates.set(tabId, new Map([[slot, value]]));
}

/** Drop every slot saved for a tab — called when the tab leaves the pool. */
export function deleteTabViewState(tabId: string): void {
  tabViewStates.delete(tabId);
}

/** Drop all saved view state (close-all, tests). */
export function clearTabViewStates(): void {
  tabViewStates.clear();
}

/** Number of tabs with saved view state (tests / diagnostics). */
export function getTabViewStateCount(): number {
  return tabViewStates.size;
}
