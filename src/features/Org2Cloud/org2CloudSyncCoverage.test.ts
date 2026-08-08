import { describe, expect, it } from "vitest";

import {
  type RepoScopeResolver,
  type SyncCoverageSession,
  computeSessionSyncCoverage,
  createOrgSyncCoverageEligibilityResolver,
  isSyncCoverageSession,
  pushedSessionIdsForOrg,
} from "./org2CloudSyncCoverage";

function session(
  session_id: string,
  overrides: Partial<SyncCoverageSession> = {}
): SyncCoverageSession {
  return { session_id, ...overrides };
}

const IMPORTED_FROM = {
  orgId: "org-a",
  sourceSessionId: "remote-1",
  ownerMemberId: "member-1",
  epoch: 1,
  seq: 1,
  count: 1,
} as SyncCoverageSession["importedFrom"];

/**
 * Stand-in for `createOrgRepoScopeResolver`: matches `repoPath` against the
 * given scopes so grouping is testable without the async scope-key caches.
 * Same three-way contract — scope string / null (out of scope) / undefined.
 */
function scopedBy(...scopes: string[]): RepoScopeResolver {
  return (s) => {
    if (s.repoPath === undefined) return null;
    if (s.repoPath === "pending") return undefined;
    return scopes.includes(s.repoPath) ? s.repoPath : null;
  };
}

describe("isSyncCoverageSession", () => {
  it("counts an ordinary local session", () => {
    expect(isSyncCoverageSession(session("s1"))).toBe(true);
  });

  it("drops a subagent session carrying a parent id", () => {
    expect(
      isSyncCoverageSession(session("s1", { parentSessionId: "root" }))
    ).toBe(false);
  });

  it("drops a subagent session identified by its id segment", () => {
    expect(isSyncCoverageSession(session("root:subagent:1"))).toBe(false);
  });

  it("drops an Agent-Team worker session", () => {
    expect(isSyncCoverageSession(session("s1", { orgMemberId: "m1" }))).toBe(
      false
    );
  });

  it("keeps an Agent-Team ROOT session (member id plus agent org)", () => {
    expect(
      isSyncCoverageSession(
        session("s1", { orgMemberId: "m1", agentOrgId: "ao1" })
      )
    ).toBe(true);
  });

  it("drops a teammate copy imported from an org", () => {
    expect(
      isSyncCoverageSession(session("s1", { importedFrom: IMPORTED_FROM }))
    ).toBe(false);
  });
});

describe("createOrgSyncCoverageEligibilityResolver", () => {
  it("excludes an ordinary Personal session even when its repo is scoped", () => {
    const eligible = createOrgSyncCoverageEligibilityResolver({
      orgId: "org-a",
      tags: {},
      accessByOrg: {},
      floorByOrg: { "org-a": "metadata_only" },
    });

    expect(eligible(session("personal"))).toBe(false);
  });

  it("admits an org-owned session at the org sharing floor", () => {
    const eligible = createOrgSyncCoverageEligibilityResolver({
      orgId: "org-a",
      tags: {},
      accessByOrg: {},
      floorByOrg: { "org-a": "metadata_only" },
    });

    expect(eligible(session("owned", { orgId: "cloud:org-a" }))).toBe(true);
  });

  it("requires effective access for an admitted but unfloored session", () => {
    const eligible = createOrgSyncCoverageEligibilityResolver({
      orgId: "org-a",
      tags: {},
      accessByOrg: {},
      floorByOrg: {},
    });

    expect(eligible(session("owned", { orgId: "cloud:org-a" }))).toBe(false);
  });

  it("treats an explicit tag as admission and metadata-only access", () => {
    const eligible = createOrgSyncCoverageEligibilityResolver({
      orgId: "org-a",
      tags: { tagged: ["cloud:org-a"] },
      accessByOrg: {},
      floorByOrg: {},
    });

    expect(eligible(session("tagged"))).toBe(true);
  });

  it("does not admit an untagged fork to a different org", () => {
    const eligible = createOrgSyncCoverageEligibilityResolver({
      orgId: "org-a",
      tags: {},
      accessByOrg: {},
      floorByOrg: { "org-a": "metadata_only" },
    });

    expect(
      eligible(
        session("fork", {
          orgId: "cloud:org-a",
          forkedFrom: { orgId: "org-b" } as never,
        })
      )
    ).toBe(false);
  });
});

describe("pushedSessionIdsForOrg", () => {
  it("keeps only this org's keys and strips the prefix", () => {
    const ids = pushedSessionIdsForOrg(
      "org-a",
      { "org-a:s1": true, "org-b:s2": true },
      { "org-a:s3": {} }
    );
    expect([...ids].sort()).toEqual(["s1", "s3"]);
  });

  it("cuts only the org prefix when the session id contains a colon", () => {
    const ids = pushedSessionIdsForOrg(
      "org-a",
      { "org-a:root:subagent:1": true },
      {}
    );
    expect([...ids]).toEqual(["root:subagent:1"]);
  });

  it("does not treat a longer org id as a prefix match", () => {
    const ids = pushedSessionIdsForOrg("org-a", { "org-a2:s1": true }, {});
    expect(ids.size).toBe(0);
  });
});

describe("computeSessionSyncCoverage", () => {
  it("reports no repos and a null percent for an empty roster", () => {
    expect(computeSessionSyncCoverage([], new Set(), scopedBy())).toEqual({
      repos: [],
      syncable: 0,
      synced: 0,
      percent: null,
    });
  });

  it("gives each scoped repo its own row with its own percentage", () => {
    const coverage = computeSessionSyncCoverage(
      [
        session("s1", { repoPath: "alpha" }),
        session("s2", { repoPath: "alpha" }),
        session("s3", { repoPath: "alpha" }),
        session("s4", { repoPath: "beta" }),
      ],
      new Set(["s1", "s2"]),
      scopedBy("alpha", "beta")
    );

    expect(coverage.repos).toEqual([
      { repoScope: "alpha", syncable: 3, synced: 2, percent: 67 },
      { repoScope: "beta", syncable: 1, synced: 0, percent: 0 },
    ]);
    expect(coverage.syncable).toBe(4);
    expect(coverage.synced).toBe(2);
    expect(coverage.percent).toBe(50);
  });

  it("lists ONLY the org's scoped repos, never the rest of the device", () => {
    const coverage = computeSessionSyncCoverage(
      [
        session("s1", { repoPath: "alpha" }),
        // Out of scope, and a session with no repo at all: neither is work
        // this org can receive, so neither becomes a row.
        session("s2", { repoPath: "personal-side-project" }),
        session("s3"),
      ],
      new Set(["s1"]),
      scopedBy("alpha")
    );

    expect(coverage.repos).toEqual([
      { repoScope: "alpha", syncable: 1, synced: 1, percent: 100 },
    ]);
    // The out-of-scope sessions must not drag the headline down either.
    expect(coverage.syncable).toBe(1);
    expect(coverage.percent).toBe(100);
  });

  it("reports nothing when the org has no repo scopes configured", () => {
    const coverage = computeSessionSyncCoverage(
      [session("s1", { repoPath: "alpha" }), session("s2")],
      new Set(["s1"]),
      scopedBy()
    );

    expect(coverage).toEqual({
      repos: [],
      syncable: 0,
      synced: 0,
      percent: null,
    });
  });

  it("excludes subagent and imported sessions from every row", () => {
    const coverage = computeSessionSyncCoverage(
      [
        session("s1", { repoPath: "alpha" }),
        session("s2", { repoPath: "alpha", parentSessionId: "s1" }),
        session("s1:subagent:0", { repoPath: "alpha" }),
        session("s3", { repoPath: "alpha", importedFrom: IMPORTED_FROM }),
      ],
      new Set(["s1", "s2", "s1:subagent:0", "s3"]),
      scopedBy("alpha")
    );

    expect(coverage.repos).toEqual([
      { repoScope: "alpha", syncable: 1, synced: 1, percent: 100 },
    ]);
    expect(coverage.syncable).toBe(1);
  });

  it("skips sessions whose scope lookup is still in flight", () => {
    const coverage = computeSessionSyncCoverage(
      [
        session("s1", { repoPath: "alpha" }),
        session("s2", { repoPath: "pending" }),
      ],
      new Set(),
      scopedBy("alpha", "pending")
    );

    // s2 contributes to nothing — not a row, not the totals — until the
    // resolver answers for it.
    expect(coverage.repos).toEqual([
      { repoScope: "alpha", syncable: 1, synced: 0, percent: 0 },
    ]);
    expect(coverage.syncable).toBe(1);
  });

  it("orders by size, then scope string", () => {
    const coverage = computeSessionSyncCoverage(
      [
        session("s1", { repoPath: "zeta" }),
        session("s2", { repoPath: "alpha" }),
        session("s3", { repoPath: "big" }),
        session("s4", { repoPath: "big" }),
      ],
      new Set(),
      scopedBy("alpha", "big", "zeta")
    );

    expect(coverage.repos.map((row) => row.repoScope)).toEqual([
      "big",
      "alpha",
      "zeta",
    ]);
  });

  it("ignores push markers for sessions no longer in the roster", () => {
    const coverage = computeSessionSyncCoverage(
      [session("s1", { repoPath: "alpha" })],
      new Set(["s1", "gone-1", "gone-2"]),
      scopedBy("alpha")
    );

    expect(coverage.repos[0]).toEqual({
      repoScope: "alpha",
      syncable: 1,
      synced: 1,
      percent: 100,
    });
  });

  it("rounds each row and the total independently", () => {
    const sessions = Array.from({ length: 3 }, (_, index) =>
      session(`s${index}`, { repoPath: "alpha" })
    );
    expect(
      computeSessionSyncCoverage(sessions, new Set(["s0"]), scopedBy("alpha"))
        .repos[0]?.percent
    ).toBe(33);
    expect(
      computeSessionSyncCoverage(
        sessions,
        new Set(["s0", "s1"]),
        scopedBy("alpha")
      ).percent
    ).toBe(67);
  });
});
