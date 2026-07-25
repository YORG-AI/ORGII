import { describe, expect, it } from "vitest";

import { collectScopeMatchedImportedSessionIds } from "./importedSessionScopeMatch";

const sessions = [
  {
    session_id: "claudecodeapp-1",
    repoPath: "/Users/me/org2",
    repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
  },
  {
    session_id: "codexapp-2",
    repoPath: "/Users/me/other",
    repoRemoteUrls: ["https://github.com/org2ai/other.git"],
  },
  {
    session_id: "native-1",
    repoPath: "/Users/me/org2",
    repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
  },
  {
    session_id: "claudecodeapp-4",
    repoPath: undefined,
    repoRemoteUrls: undefined,
  },
  {
    session_id: "claudecodeapp-agent-a5",
    repoPath: "/Users/me/org2",
    repoRemoteUrls: ["git@github.com:yorgai/org2.git"],
    parentSessionId: "claudecodeapp-1",
  },
];

describe("collectScopeMatchedImportedSessionIds", () => {
  it("matches imported sessions whose repo is inside the org scope", () => {
    const ids = collectScopeMatchedImportedSessionIds(sessions, [
      "github.com/org2ai/org2",
    ]);
    expect(ids).toEqual(new Set(["claudecodeapp-1"]));
  });

  it("returns empty for a scope-less org", () => {
    expect(collectScopeMatchedImportedSessionIds(sessions, [])).toEqual(
      new Set()
    );
    expect(collectScopeMatchedImportedSessionIds(sessions, undefined)).toEqual(
      new Set()
    );
  });

  it("skips native and repo-less sessions", () => {
    const ids = collectScopeMatchedImportedSessionIds(sessions, [
      "github.com/org2ai/org2",
      "github.com/org2ai/other",
    ]);
    expect(ids.has("native-1")).toBe(false);
    expect(ids.has("claudecodeapp-4")).toBe(false);
  });

  it("skips spawned children — subagent transcripts fold into their parent", () => {
    // Without this, every subagent transcript in a scoped checkout published
    // as its own top-level team session (a wall of prompt-titled rows the
    // team list cannot fold: the cloud row has no parent linkage).
    const ids = collectScopeMatchedImportedSessionIds(sessions, [
      "github.com/yorgai/org2",
    ]);
    expect(ids.has("claudecodeapp-agent-a5")).toBe(false);
  });

  it("matches sessions sharing one persisted remote identity", () => {
    const ids = collectScopeMatchedImportedSessionIds(
      [
        {
          session_id: "claudecodeapp-1",
          repoPath: "/Users/me/org2",
          repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
        },
        {
          session_id: "codexapp-2",
          repoPath: "/Users/me/org2/src-tauri",
          repoRemoteUrls: ["https://github.com/org2ai/org2"],
        },
        {
          session_id: "claudecodeapp-3",
          repoPath: "/Users/me/other",
          repoRemoteUrls: ["https://github.com/org2ai/other"],
        },
      ],
      ["github.com/org2ai/org2"]
    );
    expect(ids).toEqual(new Set(["claudecodeapp-1", "codexapp-2"]));
  });

  it("uses cached remotes even when the historical worktree no longer exists", () => {
    const ids = collectScopeMatchedImportedSessionIds(
      [
        {
          session_id: "claudecodeapp-stale",
          repoPath: "/Users/me/org2/.claude/worktrees/deleted-agent",
          repoRemoteUrls: ["git@github.com:org2ai/org2.git"],
        },
      ],
      ["github.com/org2ai/org2"]
    );
    expect(ids).toEqual(new Set(["claudecodeapp-stale"]));
  });
});
