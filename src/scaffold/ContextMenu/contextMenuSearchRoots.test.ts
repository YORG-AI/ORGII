import { describe, expect, it } from "vitest";

import {
  attachSearchRootMetadata,
  buildContextMenuSearchRoots,
  buildRootSearchResult,
  mergeSearchResultsByRoot,
} from "./contextMenuSearchRoots";

describe("contextMenuSearchRoots", () => {
  it("uses all workspace folders before adding a fallback repo path", () => {
    const roots = buildContextMenuSearchRoots({
      repoPath: "/workspace/primary/",
      currentRepo: { name: "Primary Repo", path: "/workspace/primary" },
      workspaceFolders: [
        { name: "Primary", path: "/workspace/primary/" },
        { name: "Secondary", path: "/workspace/secondary" },
      ],
    });

    expect(roots).toEqual([
      { name: "Primary", path: "/workspace/primary" },
      { name: "Secondary", path: "/workspace/secondary" },
    ]);
  });

  it("falls back to current repo when no workspace folders are active", () => {
    const roots = buildContextMenuSearchRoots({
      currentRepo: { name: "Current Repo", path: "/workspace/current" },
      workspaceFolders: [],
    });

    expect(roots).toEqual([
      { name: "Current Repo", path: "/workspace/current" },
    ]);
  });

  it("builds a selectable repo result for the search root", () => {
    expect(
      buildRootSearchResult({
        name: "Current Repo",
        path: "/workspace/current",
      })
    ).toEqual({
      type: "folder",
      path: "/workspace/current",
      name: "Current Repo",
      repoPath: "/workspace/current",
      repoName: "Current Repo",
      iconType: "repo",
    });
  });

  it("keeps colliding result paths from different roots distinct", () => {
    const primary = { name: "Primary", path: "/workspace/primary" };
    const secondary = { name: "Secondary", path: "/workspace/secondary" };
    const merged = mergeSearchResultsByRoot(
      [
        attachSearchRootMetadata(
          [{ type: "file", path: "src/index.tsx", name: "index.tsx" }],
          primary
        ),
        attachSearchRootMetadata(
          [{ type: "file", path: "src/index.tsx", name: "index.tsx" }],
          secondary
        ),
      ],
      20
    );

    expect(merged).toEqual([
      {
        type: "file",
        path: "src/index.tsx",
        name: "index.tsx",
        repoPath: "/workspace/primary",
        repoName: "Primary",
      },
      {
        type: "file",
        path: "src/index.tsx",
        name: "index.tsx",
        repoPath: "/workspace/secondary",
        repoName: "Secondary",
      },
    ]);
  });

  it("deduplicates the same result within the same root", () => {
    const root = { name: "Primary", path: "/workspace/primary" };
    const merged = mergeSearchResultsByRoot(
      [
        attachSearchRootMetadata(
          [
            { type: "file", path: "/workspace/primary/src/index.tsx" },
            { type: "file", path: "/workspace/primary/src/index.tsx" },
          ],
          root
        ),
      ],
      20
    );

    expect(merged).toHaveLength(1);
  });
});
