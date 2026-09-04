import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
  pinnedActionsVisibleAtom,
} from "../pinnedActionsVisibleAtom";

beforeEach(() => {
  localStorage.removeItem(PINNED_ACTIONS_VISIBLE_STORAGE_KEY);
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(pinnedActionsVisibleAtom, () => undefined);
  return store;
}

describe("pinnedActionsVisibleAtom", () => {
  it("hides pinned actions by default", () => {
    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(false);
  });

  it("persists a visible choice and hydrates it in a new store", () => {
    const firstStore = hydratedStore();
    firstStore.set(pinnedActionsVisibleAtom, true);

    expect(
      JSON.parse(
        localStorage.getItem(PINNED_ACTIONS_VISIBLE_STORAGE_KEY) ?? "null"
      )
    ).toBe(true);

    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(true);
  });

  it("falls back to hidden for malformed persisted values", () => {
    localStorage.setItem(
      PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
      JSON.stringify("hidden")
    );

    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(false);
  });
});
