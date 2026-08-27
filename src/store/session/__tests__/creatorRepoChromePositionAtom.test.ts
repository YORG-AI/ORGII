import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it } from "vitest";

import {
  CREATOR_REPO_CHROME_POSITION_STORAGE_KEY,
  creatorRepoChromePositionAtom,
  resolveCreatorRepoChromePosition,
} from "../creatorRepoChromePositionAtom";

beforeEach(() => {
  localStorage.removeItem(CREATOR_REPO_CHROME_POSITION_STORAGE_KEY);
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  store.sub(creatorRepoChromePositionAtom, () => undefined);
  return store;
}

describe("creatorRepoChromePositionAtom", () => {
  it("preserves each layout's established position until the user chooses", () => {
    expect(resolveCreatorRepoChromePosition(null, "top")).toBe("top");
    expect(resolveCreatorRepoChromePosition(null, "bottom")).toBe("bottom");
  });

  it("lets an explicit preference override either layout fallback", () => {
    expect(resolveCreatorRepoChromePosition("bottom", "top")).toBe("bottom");
    expect(resolveCreatorRepoChromePosition("top", "bottom")).toBe("top");
  });

  it("persists an explicit position and hydrates it in a new store", () => {
    const firstStore = hydratedStore();
    firstStore.set(creatorRepoChromePositionAtom, "bottom");

    expect(
      JSON.parse(
        localStorage.getItem(CREATOR_REPO_CHROME_POSITION_STORAGE_KEY) ?? "null"
      )
    ).toBe("bottom");

    const secondStore = hydratedStore();
    expect(secondStore.get(creatorRepoChromePositionAtom)).toBe("bottom");
  });

  it("rejects malformed persisted values at the storage boundary", () => {
    localStorage.setItem(
      CREATOR_REPO_CHROME_POSITION_STORAGE_KEY,
      JSON.stringify("sideways")
    );

    expect(hydratedStore().get(creatorRepoChromePositionAtom)).toBeNull();
  });
});
