import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RepoItem, SpotlightItemData } from "../../../types";
import {
  buildRepoSpotlightItem,
  buildRepoSpotlightItems,
  sortRepoItemsSelectedFirst,
} from "../repoAdapter";

// `repoAdapter` transitively imports `@src/store/repo`, which uses
// jotai's `atomWithStorage(localStorage|sessionStorage)` at module
// load. The Vitest `node` environment has neither global, so install
// minimal in-memory shims before any other import is evaluated.
// `vi.hoisted` runs before the hoisted import statements below.
vi.hoisted(() => {
  function makeStorage(): Storage {
    const memory: Record<string, string> = {};
    return {
      get length() {
        return Object.keys(memory).length;
      },
      clear() {
        for (const key of Object.keys(memory)) delete memory[key];
      },
      getItem(key: string) {
        return Object.prototype.hasOwnProperty.call(memory, key)
          ? memory[key]
          : null;
      },
      key(index: number) {
        return Object.keys(memory)[index] ?? null;
      },
      removeItem(key: string) {
        delete memory[key];
      },
      setItem(key: string, value: string) {
        memory[key] = String(value);
      },
    };
  }
  for (const name of ["localStorage", "sessionStorage"] as const) {
    if (typeof (globalThis as Record<string, unknown>)[name] !== "undefined") {
      continue;
    }
    Object.defineProperty(globalThis, name, {
      value: makeStorage(),
      writable: true,
    });
  }
});

const baseRepo: RepoItem = {
  id: "repo-1",
  name: "alpha",
  gitStatus: { uncommittedFiles: 3, ahead: 1, behind: 0 },
};

describe("buildRepoSpotlightItem", () => {
  it("preserves git status and omits manage UI in normal mode", () => {
    const onAction = vi.fn();
    const item = buildRepoSpotlightItem(baseRepo, {
      currentRepoId: "repo-1",
      onAction,
    });

    expect(item.id).toBe("repo-1");
    expect(item.label).toBe("alpha");
    expect(item.type).toBe("repo");
    expect(item.data?.isCurrentSelection).toBe(true);
    expect(item.data?.gitStatus).toEqual(baseRepo.gitStatus);
    expect(item.data?.rightContent).toBeUndefined();
    expect(item.data?.selectionState).toBeUndefined();

    item.action?.();
    expect(onAction).toHaveBeenCalledWith(baseRepo);
  });

  it("hides git status and renders manageAction in manage mode", () => {
    const sentinel = { __sentinel: true } as unknown as ReactNode;
    const manageAction = vi.fn(() => sentinel);
    const item = buildRepoSpotlightItem(baseRepo, {
      onAction: () => {},
      manageAction,
    });

    expect(item.data?.gitStatus).toBeUndefined();
    expect(item.data?.rightContent).toBe(sentinel);
    expect(manageAction).toHaveBeenCalledWith(baseRepo);
  });

  it("threads selectionState from getSelectionState", () => {
    const onToggle = vi.fn();
    const selection: NonNullable<SpotlightItemData["selectionState"]> = {
      checked: true,
      onToggle,
    };
    const getSelectionState = vi.fn(() => selection);
    const item = buildRepoSpotlightItem(baseRepo, {
      onAction: () => {},
      getSelectionState,
    });

    expect(item.data?.selectionState).toBe(selection);
    expect(getSelectionState).toHaveBeenCalledWith(baseRepo);
  });

  it("does not set selectionState when getSelectionState returns undefined", () => {
    const item = buildRepoSpotlightItem(baseRepo, {
      onAction: () => {},
      getSelectionState: () => undefined,
    });
    expect(item.data?.selectionState).toBeUndefined();
  });

  it("respects idPrefix to avoid collisions when combining lists", () => {
    const item = buildRepoSpotlightItem(baseRepo, {
      onAction: () => {},
      idPrefix: "manage-",
    });
    expect(item.id).toBe("manage-repo-1");
  });

  it("exposes normalized name and path copy targets", () => {
    const item = buildRepoSpotlightItem(
      {
        ...baseRepo,
        fs_uri: "file:///Users/example/alpha/",
      },
      { onAction: () => {} }
    );

    expect(item.data?.contextMenuCopy).toEqual({
      name: "alpha",
      path: "/Users/example/alpha",
    });
  });

  it("uses folder icon for folder kind and repo icon otherwise", () => {
    const folderItem = buildRepoSpotlightItem(
      { id: "f1", name: "f", kind: "folder" },
      { onAction: () => {} }
    );
    const gitItem = buildRepoSpotlightItem(
      { id: "g1", name: "g", kind: "git" },
      { onAction: () => {} }
    );
    expect(folderItem.icon).toBeDefined();
    expect(gitItem.icon).toBeDefined();
    expect(folderItem.icon).not.toBe(gitItem.icon);
  });
});

describe("buildRepoSpotlightItem path visibility", () => {
  const repoWithPath: RepoItem = {
    id: "repo-2",
    name: "beta",
    fs_uri: "file:///Users/dev/code/beta/",
  };

  it("omits the path by default", () => {
    const item = buildRepoSpotlightItem(repoWithPath, { onAction: () => {} });

    expect(item.desc).toBeUndefined();
    expect(item.data?.contextMenuCopy?.path).toBe("/Users/dev/code/beta");
  });

  it("renders the path as the row description when showPath is on", () => {
    const item = buildRepoSpotlightItem(repoWithPath, {
      onAction: () => {},
      showPath: true,
    });

    expect(item.desc).toContain("beta");
  });

  it("stays path-less when the repo has no filesystem uri", () => {
    const item = buildRepoSpotlightItem(baseRepo, {
      onAction: () => {},
      showPath: true,
    });

    expect(item.desc).toBeUndefined();
  });
});

describe("buildRepoSpotlightItems", () => {
  it("maps every repo and forwards options consistently", () => {
    const repos: RepoItem[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const onAction = vi.fn();
    const items = buildRepoSpotlightItems(repos, {
      currentRepoId: "b",
      onAction,
    });
    expect(items).toHaveLength(2);
    expect(items[0].data?.isCurrentSelection).toBe(false);
    expect(items[1].data?.isCurrentSelection).toBe(true);
    items[0].action?.();
    expect(onAction).toHaveBeenCalledWith(repos[0]);
  });
});

describe("sortRepoItemsSelectedFirst", () => {
  it("moves the currently-selected repo to the top", () => {
    const repos: RepoItem[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ];
    const items = buildRepoSpotlightItems(repos, {
      currentRepoId: "c",
      onAction: () => {},
    });
    const sorted = sortRepoItemsSelectedFirst(items);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
  });

  it("returns a stable order when no item is selected", () => {
    const repos: RepoItem[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const items = buildRepoSpotlightItems(repos, { onAction: () => {} });
    const sorted = sortRepoItemsSelectedFirst(items);
    expect(sorted.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const repos: RepoItem[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ];
    const items = buildRepoSpotlightItems(repos, {
      currentRepoId: "b",
      onAction: () => {},
    });
    const before = items.map((entry) => entry.id);
    sortRepoItemsSelectedFirst(items);
    expect(items.map((entry) => entry.id)).toEqual(before);
  });
});
