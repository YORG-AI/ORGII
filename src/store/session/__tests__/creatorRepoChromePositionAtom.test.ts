import { createStore } from "jotai/vanilla";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CREATOR_COMPOSER_POSITION } from "@src/config/sessionCreatorConfig";

import { creatorComposerPositionAtom } from "../creatorComposerPositionAtom";
import {
  CREATOR_REPO_CHROME_POSITION_STORAGE_KEY,
  changeCreatorComposerPositionAtom,
  creatorRepoChromePositionAtom,
} from "../creatorRepoChromePositionAtom";

const subscriptions: Array<() => void> = [];

beforeEach(() => {
  localStorage.removeItem("orgii:newChat:composerPosition");
  localStorage.removeItem(CREATOR_REPO_CHROME_POSITION_STORAGE_KEY);
});

afterEach(() => {
  subscriptions.splice(0).forEach((unsubscribe) => unsubscribe());
});

function hydratedStore(): ReturnType<typeof createStore> {
  const store = createStore();
  subscriptions.push(
    store.sub(creatorComposerPositionAtom, () => undefined),
    store.sub(creatorRepoChromePositionAtom, () => undefined)
  );
  return store;
}

describe("creatorRepoChromePositionAtom", () => {
  it("follows input placement without persisting the automatic trail default", () => {
    const store = hydratedStore();
    expect(store.get(creatorRepoChromePositionAtom)).toBe("top");

    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.MIDDLE
    );
    expect(store.get(creatorRepoChromePositionAtom)).toBe("bottom");

    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.BOTTOM
    );
    expect(store.get(creatorRepoChromePositionAtom)).toBe("top");
    expect(
      localStorage.getItem(CREATOR_REPO_CHROME_POSITION_STORAGE_KEY)
    ).toBeNull();
  });

  it.each([
    {
      from: CREATOR_COMPOSER_POSITION.BOTTOM,
      to: CREATOR_COMPOSER_POSITION.MIDDLE,
      override: "top",
      expected: "bottom",
    },
    {
      from: CREATOR_COMPOSER_POSITION.MIDDLE,
      to: CREATOR_COMPOSER_POSITION.BOTTOM,
      override: "bottom",
      expected: "top",
    },
  ] as const)(
    "switching to $to resets a saved $override trail to $expected",
    ({ from, to, override, expected }) => {
      const store = hydratedStore();
      store.set(changeCreatorComposerPositionAtom, from);
      store.set(creatorRepoChromePositionAtom, override);
      expect(store.get(creatorRepoChromePositionAtom)).toBe(override);

      store.set(changeCreatorComposerPositionAtom, to);
      expect(store.get(creatorRepoChromePositionAtom)).toBe(expected);
      expect(
        localStorage.getItem(CREATOR_REPO_CHROME_POSITION_STORAGE_KEY)
      ).toBeNull();
      expect(
        JSON.parse(
          localStorage.getItem("orgii:newChat:composerPosition") ?? "null"
        )
      ).toBe(to);

      const restoredStore = hydratedStore();
      expect(restoredStore.get(creatorComposerPositionAtom)).toBe(to);
      expect(restoredStore.get(creatorRepoChromePositionAtom)).toBe(expected);
    }
  );

  it("allows a trail override after switching and keeps it when reselecting the current layout", () => {
    const store = hydratedStore();
    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.MIDDLE
    );
    store.set(creatorRepoChromePositionAtom, "top");
    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.MIDDLE
    );
    expect(store.get(creatorRepoChromePositionAtom)).toBe("top");
    expect(hydratedStore().get(creatorRepoChromePositionAtom)).toBe("top");
  });

  it("uses a saved Middle layout to resolve the initial default", () => {
    localStorage.setItem(
      "orgii:newChat:composerPosition",
      JSON.stringify(CREATOR_COMPOSER_POSITION.MIDDLE)
    );
    expect(hydratedStore().get(creatorRepoChromePositionAtom)).toBe("bottom");
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

    const store = hydratedStore();
    expect(store.get(creatorRepoChromePositionAtom)).toBe("top");
    store.set(
      changeCreatorComposerPositionAtom,
      CREATOR_COMPOSER_POSITION.MIDDLE
    );
    expect(store.get(creatorRepoChromePositionAtom)).toBe("bottom");
  });
});
