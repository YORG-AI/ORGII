import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
  pinnedActionsVisibleAtom,
} from "../creatorPinnedActionsVisibleAtom";

beforeEach(() => {
  localStorage.removeItem(PINNED_ACTIONS_VISIBLE_STORAGE_KEY);
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(pinnedActionsVisibleAtom, () => undefined);
  return store;
}

describe("pinnedActionsVisibleAtom", () => {
  it("shows pinned actions by default", () => {
    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(true);
  });

  it("persists a hidden choice and hydrates it in a new store", () => {
    const firstStore = hydratedStore();
    firstStore.set(pinnedActionsVisibleAtom, false);

    expect(
      JSON.parse(
        localStorage.getItem(PINNED_ACTIONS_VISIBLE_STORAGE_KEY) ?? "null"
      )
    ).toBe(false);

    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(false);
  });

  it("falls back to visible for malformed persisted values", () => {
    localStorage.setItem(
      PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
      JSON.stringify("hidden")
    );

    expect(hydratedStore().get(pinnedActionsVisibleAtom)).toBe(true);
  });
});
