import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY,
  creatorLaunchpadActionsVisibleAtom,
} from "../creatorLaunchpadActionsVisibleAtom";

beforeEach(() => {
  localStorage.removeItem(CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY);
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(creatorLaunchpadActionsVisibleAtom, () => undefined);
  return store;
}

describe("creatorLaunchpadActionsVisibleAtom", () => {
  it("shows launchpad quick actions by default", () => {
    expect(hydratedStore().get(creatorLaunchpadActionsVisibleAtom)).toBe(true);
  });

  it("persists a hidden choice and hydrates it in a new store", () => {
    const firstStore = hydratedStore();
    firstStore.set(creatorLaunchpadActionsVisibleAtom, false);

    expect(
      JSON.parse(
        localStorage.getItem(CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY) ??
          "null"
      )
    ).toBe(false);
    expect(hydratedStore().get(creatorLaunchpadActionsVisibleAtom)).toBe(false);
  });

  it("falls back to visible for malformed persisted values", () => {
    localStorage.setItem(
      CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY,
      JSON.stringify("hidden")
    );

    expect(hydratedStore().get(creatorLaunchpadActionsVisibleAtom)).toBe(true);
  });
});
