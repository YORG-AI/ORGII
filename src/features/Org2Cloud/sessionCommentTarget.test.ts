import { describe, expect, it } from "vitest";

import { cloudOrgToken } from "@src/features/TeamCollaboration/sessionOrgTagsAtom";

import { resolveSessionCommentTarget } from "./sessionCommentTarget";

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
