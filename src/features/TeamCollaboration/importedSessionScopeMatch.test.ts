import { describe, expect, it, vi } from "vitest";

import { collectScopeMatchedImportedSessionIds } from "./importedSessionScopeMatch";

const PEEK = (path: string) =>
  path === "/Users/me/org2"
    ? ["github.com/yorgai/org2"]
    : path === "/Users/me/other"
      ? ["github.com/yorgai/other"]
      : null;

const sessions = [
  {
    session_id: "claudecodeapp-1",
    repoPath: "/Users/me/org2",
  },
  {
    session_id: "codexapp-2",
    repoPath: "/Users/me/other",
  },
  {
    session_id: "native-1",
    repoPath: "/Users/me/org2",
  },
  {
    session_id: "claudecodeapp-4",
    repoPath: undefined,
  },
];

describe("collectScopeMatchedImportedSessionIds", () => {
  it("matches imported sessions whose repo is inside the org scope", () => {
    const ids = collectScopeMatchedImportedSessionIds(
      sessions,
      ["github.com/yorgai/org2"],
      PEEK
    );
    expect(ids).toEqual(new Set(["claudecodeapp-1"]));
  });

  it("returns empty for a scope-less org", () => {
    expect(collectScopeMatchedImportedSessionIds(sessions, [], PEEK)).toEqual(
      new Set()
    );
    expect(
      collectScopeMatchedImportedSessionIds(sessions, undefined, PEEK)
    ).toEqual(new Set());
  });

  it("skips native and repo-less sessions", () => {
    const ids = collectScopeMatchedImportedSessionIds(
      sessions,
      ["github.com/yorgai/org2", "github.com/yorgai/other"],
      PEEK
    );
    expect(ids.has("native-1")).toBe(false);
    expect(ids.has("claudecodeapp-4")).toBe(false);
  });

  it("evaluates each unique repoPath once", () => {
    const peek = vi.fn(PEEK);
    const ids = collectScopeMatchedImportedSessionIds(
      [
        { session_id: "claudecodeapp-1", repoPath: "/Users/me/org2" },
        { session_id: "codexapp-2", repoPath: "/Users/me/org2" },
        { session_id: "claudecodeapp-3", repoPath: "/Users/me/other" },
      ],
      ["github.com/yorgai/org2"],
      peek
    );
    expect(ids).toEqual(new Set(["claudecodeapp-1", "codexapp-2"]));
    expect(peek).toHaveBeenCalledTimes(2);
  });

  it("primes unresolved paths and defers matching", () => {
    const prime = vi.fn();
    const ids = collectScopeMatchedImportedSessionIds(
      sessions,
      ["github.com/yorgai/org2"],
      () => undefined,
      prime
    );
    expect(ids.size).toBe(0);
    expect(prime).toHaveBeenCalledWith("/Users/me/org2");
  });
});
