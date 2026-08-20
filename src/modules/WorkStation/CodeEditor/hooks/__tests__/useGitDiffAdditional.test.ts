/**
 * Additional gitDiffReducer coverage — actions not exercised by the
 * existing scope-merge tests in useGitDiffState.test.ts.
 *
 * Covers: REMOVE_FILE, CLEAR_FILES, ADD_TAB, REMOVE_TAB, SET_TABS,
 *         CLEAR_TABS, SET_LOADING, BATCH, SET_FILE content-merge,
 *         and the `areGitFileMapsEqual` no-op optimisation.
 */
import { describe, expect, it } from "vitest";

import {
  type GitDiffAction,
  gitDiffReducer,
  initialGitDiffState,
} from "@src/modules/WorkStation/CodeEditor/hooks/useGitDiffState";
import type { GitFile } from "@src/types/git/types";

function f(path: string, overrides: Partial<GitFile> = {}): GitFile {
  return {
    id: path,
    path,
    status: "modified",
    additions: 0,
    deletions: 0,
    staged: false,
    ...overrides,
  };
}

const s0 = initialGitDiffState;

describe("SET_FILE", () => {
  it("inserts a new file", () => {
    const next = gitDiffReducer(s0, {
      type: "SET_FILE",
      path: "/a.ts",
      file: f("/a.ts"),
    });
    expect(next.filesByPath.has("/a.ts")).toBe(true);
  });

  it("preserves existing oldContent when incoming file omits it", () => {
    let state = gitDiffReducer(s0, {
      type: "SET_FILE",
      path: "/a.ts",
      file: f("/a.ts", { oldContent: "before", newContent: "after" }),
    });
    state = gitDiffReducer(state, {
      type: "SET_FILE",
      path: "/a.ts",
      file: f("/a.ts"),
    });
    expect(state.filesByPath.get("/a.ts")?.oldContent).toBe("before");
    expect(state.filesByPath.get("/a.ts")?.newContent).toBe("after");
  });
});

describe("REMOVE_FILE", () => {
  it("removes a known file", () => {
    let state = gitDiffReducer(s0, {
      type: "SET_FILE",
      path: "/a.ts",
      file: f("/a.ts"),
    });
    state = gitDiffReducer(state, { type: "REMOVE_FILE", path: "/a.ts" });
    expect(state.filesByPath.has("/a.ts")).toBe(false);
  });

  it("is a no-op for an unknown path", () => {
    const state = gitDiffReducer(s0, {
      type: "REMOVE_FILE",
      path: "/missing.ts",
    });
    expect(state.filesByPath.size).toBe(0);
  });
});

describe("CLEAR_FILES", () => {
  it("empties the file map", () => {
    let state = gitDiffReducer(s0, {
      type: "SET_FILE",
      path: "/a.ts",
      file: f("/a.ts"),
    });
    state = gitDiffReducer(state, { type: "CLEAR_FILES" });
    expect(state.filesByPath.size).toBe(0);
  });
});

describe("ADD_TAB / REMOVE_TAB / SET_TABS / CLEAR_TABS", () => {
  it("adds a tab id", () => {
    const state = gitDiffReducer(s0, { type: "ADD_TAB", tabId: "tab-1" });
    expect(state.openTabs.has("tab-1")).toBe(true);
  });

  it("removes a tab id", () => {
    let state = gitDiffReducer(s0, { type: "ADD_TAB", tabId: "tab-1" });
    state = gitDiffReducer(state, { type: "REMOVE_TAB", tabId: "tab-1" });
    expect(state.openTabs.has("tab-1")).toBe(false);
  });

  it("sets tabs to the provided set", () => {
    const tabs = new Set(["tab-a", "tab-b"]);
    const state = gitDiffReducer(s0, { type: "SET_TABS", tabs });
    expect(state.openTabs).toEqual(tabs);
  });

  it("clears all tabs", () => {
    let state = gitDiffReducer(s0, { type: "ADD_TAB", tabId: "tab-1" });
    state = gitDiffReducer(state, { type: "CLEAR_TABS" });
    expect(state.openTabs.size).toBe(0);
  });
});

describe("SET_LOADING", () => {
  it("flips the loading flag", () => {
    const on = gitDiffReducer(s0, { type: "SET_LOADING", loading: true });
    expect(on.loading).toBe(true);
    const off = gitDiffReducer(on, { type: "SET_LOADING", loading: false });
    expect(off.loading).toBe(false);
  });
});

describe("BATCH", () => {
  it("applies multiple actions atomically", () => {
    const state = gitDiffReducer(s0, {
      type: "BATCH",
      actions: [
        { type: "SET_FILE", path: "/a.ts", file: f("/a.ts") },
        { type: "ADD_TAB", tabId: "tab-1" },
        { type: "SET_LOADING", loading: false },
      ] as GitDiffAction[],
    });
    expect(state.filesByPath.has("/a.ts")).toBe(true);
    expect(state.openTabs.has("tab-1")).toBe(true);
    expect(state.loading).toBe(false);
  });

  it("processes an empty actions array without error", () => {
    const state = gitDiffReducer(s0, { type: "BATCH", actions: [] });
    expect(state).toBe(s0);
  });
});

describe("SET_FILES no-op optimisation", () => {
  it("returns the same reference when files are equal", () => {
    const file = f("/a.ts", { oldContent: "x", newContent: "y" });
    const seeded = gitDiffReducer(s0, {
      type: "SET_FILES",
      files: new Map([["/a.ts", file]]),
    } as GitDiffAction);

    const next = gitDiffReducer(seeded, {
      type: "SET_FILES",
      files: new Map([["/a.ts", { ...file }]]),
    } as GitDiffAction);

    expect(next).toBe(seeded);
  });
});
