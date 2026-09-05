import { useCallback, useState } from "react";

import {
  getTabViewState,
  setTabViewState,
} from "@src/store/workstation/tabs/tabViewState";

type Updater<T> = T | ((previous: T) => T);

interface TabViewStateEntry<T> {
  tabId: string;
  slot: string;
  value: T;
}

function resolveInitial<T>(initial: T | (() => T)): T {
  return typeof initial === "function" ? (initial as () => T)() : initial;
}

function readEntry<T>(
  tabId: string,
  slot: string,
  initial: T | (() => T)
): TabViewStateEntry<T> {
  const saved = getTabViewState<T>(tabId, slot);
  return {
    tabId,
    slot,
    value: saved === undefined ? resolveInitial(initial) : saved,
  };
}

/**
 * `useState` whose value survives the component being unmounted and rebuilt
 * for the same tab.
 *
 * WorkStation hosts mount only the active tab, so any `useState` in a tab
 * renderer resets on every tab switch. This hook seeds from the tab's saved
 * view state (`@src/store/workstation/tabs/tabViewState`) and writes every
 * update back, so the next mount for that tab id picks up where the user
 * left off. The store drops the slot when the tab closes.
 *
 * `tabId` may change while the component stays mounted — renderers of the
 * same tab type are reused across tabs (`UnifiedTabContent` is not keyed) —
 * in which case the value is re-read for the new tab during render. An
 * empty `tabId` behaves like plain `useState` and persists nothing.
 */
export function useTabViewState<T>(
  tabId: string,
  slot: string,
  initial: T | (() => T)
): [T, (next: Updater<T>) => void] {
  const [entry, setEntry] = useState<TabViewStateEntry<T>>(() =>
    readEntry(tabId, slot, initial)
  );

  let current = entry;
  if (entry.tabId !== tabId || entry.slot !== slot) {
    // Adjust state during render: the renderer was handed a different tab.
    current = readEntry(tabId, slot, initial);
    setEntry(current);
  }

  const setValue = useCallback((next: Updater<T>) => {
    setEntry((previous) => {
      const value =
        typeof next === "function"
          ? (next as (previous: T) => T)(previous.value)
          : next;
      if (Object.is(value, previous.value)) return previous;
      // Written from inside the updater so the store is current even if the
      // renderer unmounts before this update commits (a tab switch in the
      // same tick). The write is idempotent, so a re-run updater is harmless.
      setTabViewState(previous.tabId, previous.slot, value);
      return { ...previous, value };
    });
  }, []);

  return [current.value, setValue];
}
