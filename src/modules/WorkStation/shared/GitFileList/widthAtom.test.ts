// @vitest-environment jsdom
import { createStore } from "jotai";
import { beforeEach, describe, expect, it } from "vitest";

import {
  GIT_FILE_LIST_DEFAULT_WIDTH,
  GIT_FILE_LIST_MAX_WIDTH,
  GIT_FILE_LIST_MIN_WIDTH,
  gitFileListWidthAtom,
} from "./widthAtom";

describe("gitFileListWidthAtom", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the 200px minimum", () => {
    const store = createStore();

    expect(GIT_FILE_LIST_MIN_WIDTH).toBe(200);
    expect(GIT_FILE_LIST_DEFAULT_WIDTH).toBe(200);
    expect(store.get(gitFileListWidthAtom)).toBe(200);
  });

  it("clamps widths to the supported range", () => {
    const store = createStore();

    store.set(gitFileListWidthAtom, 180);
    expect(store.get(gitFileListWidthAtom)).toBe(GIT_FILE_LIST_MIN_WIDTH);

    store.set(gitFileListWidthAtom, 600);
    expect(store.get(gitFileListWidthAtom)).toBe(GIT_FILE_LIST_MAX_WIDTH);
  });
});
