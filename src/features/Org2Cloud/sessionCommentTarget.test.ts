import { describe, expect, it } from "vitest";

import { cloudOrgToken } from "@src/features/TeamCollaboration/sessionOrgTagsAtom";

import {
  rerootSessionCommentTarget,
  resolveSessionCommentTarget,
} from "./sessionCommentTarget";

const CLOUD_ORGS = [
  { orgId: "org-a", name: "Alpha", role: "member" },
  { orgId: "org-b", name: "Beta", role: "admin" },
];

const IMPORTED = {
  orgId: "org-a",
  sourceSessionId: "src-1",
  ownerMemberId: "user-o",
  epoch: 1,
  seq: 2,
  count: 10,
};

describe("resolveSessionCommentTarget", () => {
  it("imported teammate session targets the SOURCE coordinates", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "imported-session-1", importedFrom: IMPORTED },
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-a", sessionId: "src-1" });
  });

  it("writable forks target the parent SOURCE coordinates", () => {
    expect(
      resolveSessionCommentTarget({
        session: {
          session_id: "fork-1",
          forkedFrom: {
            orgId: "org-b",
            sourceSessionId: "parent-session",
            ownerMemberId: "user-o",
            ownerDisplayName: "Owner",
            atCount: 14,
            forkedAt: "2026-07-17T00:00:00.000Z",
            rootSessionId: "parent-session",
          },
        },
        cloudOrgs: CLOUD_ORGS,
        tags: { "fork-1": [cloudOrgToken("org-b")] },
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-b", sessionId: "parent-session" });
  });

  it("imported session whose org the viewer left resolves to null", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "imported-session-1", importedFrom: IMPORTED },
        cloudOrgs: [CLOUD_ORGS[1]], // org-a gone
        tags: {},
        preferredOrgId: null,
      })
    ).toBeNull();
  });

  it("own session tagged into one cloud org targets that org + bare id", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags: { "sess-1": [cloudOrgToken("org-b")] },
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-b", sessionId: "sess-1" });
  });

  it("own session launched in a cloud org targets its canonical org without a legacy tag", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1", orgId: cloudOrgToken("org-b") },
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-b", sessionId: "sess-1" });
  });

  it("canonical ownership and explicit tags share the active-org preference", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1", orgId: cloudOrgToken("org-a") },
        cloudOrgs: CLOUD_ORGS,
        tags: { "sess-1": [cloudOrgToken("org-b")] },
        preferredOrgId: "org-b",
      })
    ).toEqual({ orgId: "org-b", sessionId: "sess-1" });
  });

  it("multi-org tags prefer the active cloud scope, else the first tag", () => {
    const tags = {
      "sess-1": [cloudOrgToken("org-a"), cloudOrgToken("org-b")],
    };
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags,
        preferredOrgId: "org-b",
      })
    ).toEqual({ orgId: "org-b", sessionId: "sess-1" });
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags,
        preferredOrgId: "org-z",
      })
    ).toEqual({ orgId: "org-a", sessionId: "sess-1" });
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags,
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-a", sessionId: "sess-1" });
  });

  it("tags into orgs the viewer is no longer a member of are skipped", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: [CLOUD_ORGS[1]],
        tags: {
          "sess-1": [cloudOrgToken("org-a"), cloudOrgToken("org-b")],
        },
        preferredOrgId: null,
      })
    ).toEqual({ orgId: "org-b", sessionId: "sess-1" });
  });

  it("plain local sessions and null sessions resolve to null", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
      })
    ).toBeNull();
    expect(
      resolveSessionCommentTarget({
        session: null,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
      })
    ).toBeNull();
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "sess-1" },
        cloudOrgs: CLOUD_ORGS,
        tags: { "sess-1": ["org-a"] },
        preferredOrgId: null,
      })
    ).toBeNull();
  });
});

describe("repo-scope auto-match admission route", () => {
  const SCOPED = {
    session_id: "claudecodeapp-0f593918-9d8e-43cd-8b9d-4c92d1b0e8bb",
    repoPath: "/Users/me/Projects/ORGII",
    repoRemoteUrls: ["git@github.com:org2AI/ORG2.git"],
  };

  it("surfaces comments for a history shared purely by repo scope", () => {
    // The push pass admits these via isScopeMatchableImportedSession, so the
    // cloud row and its threads exist; without the same route here the owner
    // saw no comment affordance at all (no reply, no owner-only @agent).
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        orgRepoScopes: { "org-a": ["github.com/org2ai/org2"] },
      })
    ).toEqual({ orgId: "org-a", sessionId: SCOPED.session_id });
  });

  it("stays null when no org scope covers the checkout", () => {
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        orgRepoScopes: { "org-a": ["github.com/other/repo"] },
      })
    ).toBeNull();
  });

  it("ignores scopes of orgs the viewer is not a member of", () => {
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        orgRepoScopes: { "org-stranger": ["github.com/org2ai/org2"] },
      })
    ).toBeNull();
  });

  it("prefers the org holding the live server row over earlier scope matches", () => {
    // After a GitHub rename both spellings resolve to one repo network, so
    // several orgs can scope-match; only org-b ever received the push. The
    // 34e24e9e incident: candidates[0] was a scope-matching org with no row,
    // and every list call died with ORG2_SESSION_NOT_FOUND.
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        orgRepoScopes: {
          "org-a": ["github.com/org2ai/org2"],
          "org-b": ["github.com/org2ai/org2"],
        },
        pushedOrgIds: ["org-b"],
      })
    ).toEqual({ orgId: "org-b", sessionId: SCOPED.session_id });
  });

  it("keeps the full candidate set when nothing is pushed yet", () => {
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        orgRepoScopes: { "org-a": ["github.com/org2ai/org2"] },
        pushedOrgIds: ["org-elsewhere"],
      })
    ).toEqual({ orgId: "org-a", sessionId: SCOPED.session_id });
  });

  it("active-scope preference still applies within the pushed set", () => {
    expect(
      resolveSessionCommentTarget({
        session: SCOPED,
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: "org-b",
        orgRepoScopes: {
          "org-a": ["github.com/org2ai/org2"],
          "org-b": ["github.com/org2ai/org2"],
        },
        pushedOrgIds: ["org-a", "org-b"],
      })
    ).toEqual({ orgId: "org-b", sessionId: SCOPED.session_id });
  });
});

describe("pushed-row admission route", () => {
  it("a session_id-only stub with a pushed marker in a member org resolves", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "claudecodeapp-ext-1" },
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        pushedOrgIds: ["org-a"],
      })
    ).toEqual({ orgId: "org-a", sessionId: "claudecodeapp-ext-1" });
  });

  it("pushed markers in orgs the viewer left produce no candidates", () => {
    expect(
      resolveSessionCommentTarget({
        session: { session_id: "claudecodeapp-ext-1" },
        cloudOrgs: CLOUD_ORGS,
        tags: {},
        preferredOrgId: null,
        pushedOrgIds: ["org-gone"],
      })
    ).toBeNull();
  });
});

describe("rerootSessionCommentTarget", () => {
  const forkRow = {
    sourceSessionId: "fork-1",
    forkedFrom: { sourceSessionId: "root-1", rootSessionId: "root-1" },
  } as never;
  const rootRow = { sourceSessionId: "root-1" } as never;

  it("remaps a fork-family target onto the family root", () => {
    expect(
      rerootSessionCommentTarget({ orgId: "org-a", sessionId: "fork-1" }, [
        rootRow,
        forkRow,
      ])
    ).toEqual({ orgId: "org-a", sessionId: "root-1" });
  });

  it("keeps root and family-less targets unchanged", () => {
    expect(
      rerootSessionCommentTarget({ orgId: "org-a", sessionId: "root-1" }, [
        rootRow,
        forkRow,
      ])
    ).toEqual({ orgId: "org-a", sessionId: "root-1" });
    expect(
      rerootSessionCommentTarget({ orgId: "org-a", sessionId: "plain-1" }, [])
    ).toEqual({ orgId: "org-a", sessionId: "plain-1" });
    expect(rerootSessionCommentTarget(null, [rootRow])).toBeNull();
  });

  describe("expired root fallback", () => {
    const olderFork = {
      sourceSessionId: "fork-b",
      forkedFrom: {
        sourceSessionId: "root-1",
        rootSessionId: "root-1",
        forkedAt: "2026-08-21T10:00:00Z",
      },
    } as never;
    const newerFork = {
      sourceSessionId: "fork-a",
      forkedFrom: {
        sourceSessionId: "root-1",
        rootSessionId: "root-1",
        forkedAt: "2026-08-21T12:00:00Z",
      },
    } as never;

    it("targets the oldest live member when the root row expired", () => {
      expect(
        rerootSessionCommentTarget({ orgId: "org-a", sessionId: "fork-a" }, [
          newerFork,
          olderFork,
        ])
      ).toEqual({ orgId: "org-a", sessionId: "fork-b" });
    });

    it("converges the expired root's own viewpoint onto the same member", () => {
      expect(
        rerootSessionCommentTarget({ orgId: "org-a", sessionId: "root-1" }, [
          newerFork,
          olderFork,
        ])
      ).toEqual({ orgId: "org-a", sessionId: "fork-b" });
    });

    it("prefers the live root over any fallback", () => {
      expect(
        rerootSessionCommentTarget({ orgId: "org-a", sessionId: "fork-a" }, [
          rootRow,
          newerFork,
          olderFork,
        ])
      ).toEqual({ orgId: "org-a", sessionId: "root-1" });
    });
  });
});
