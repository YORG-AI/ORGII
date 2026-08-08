import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DIFF_VIEW_MODE,
  DIFF_VIEW_MODE_STORAGE_KEY,
  diffViewModeAtom,
  normalizeDiffViewMode,
} from "./diffViewModeAtom";

beforeEach(() => {
  localStorage.removeItem(DIFF_VIEW_MODE_STORAGE_KEY);
});

describe("normalizeDiffViewMode", () => {
  it("preserves supported persisted values", () => {
    expect(normalizeDiffViewMode("unified")).toBe("unified");
    expect(normalizeDiffViewMode("split")).toBe("split");
  });

  it("falls back safely when persisted data is stale or malformed", () => {
    expect(normalizeDiffViewMode("side-by-side")).toBe(DEFAULT_DIFF_VIEW_MODE);
    expect(normalizeDiffViewMode(null)).toBe(DEFAULT_DIFF_VIEW_MODE);
  });

  it("persists the latest user choice for a fresh store after reload", () => {
    const writerStore = createStore();
    const unsubscribeWriter = writerStore.sub(diffViewModeAtom, () => {});

    writerStore.set(diffViewModeAtom, "split");

    expect(localStorage.getItem(DIFF_VIEW_MODE_STORAGE_KEY)).toBe('"split"');
    unsubscribeWriter();

    const readerStore = createStore();
    const unsubscribeReader = readerStore.sub(diffViewModeAtom, () => {});

    expect(readerStore.get(diffViewModeAtom)).toBe("split");

    unsubscribeReader();
  });
});
