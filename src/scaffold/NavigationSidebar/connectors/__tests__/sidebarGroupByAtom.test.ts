// @vitest-environment jsdom
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import { sidebarGroupVisibleCountAtom } from "../sidebarGroupByAtom";

const STORAGE_KEY = "orgii:sidebarGroupVisibleCount";

describe("sidebarGroupVisibleCountAtom", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to 10 and persists supported choices", () => {
    const store = createStore();

    expect(store.get(sidebarGroupVisibleCountAtom)).toBe(10);
    store.set(sidebarGroupVisibleCountAtom, 5);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("5");
  });

  it("rejects unsupported persisted values at the storage boundary", () => {
    window.localStorage.setItem(STORAGE_KEY, "7");

    expect(createStore().get(sidebarGroupVisibleCountAtom)).toBe(10);
  });
});
