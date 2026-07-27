import { describe, expect, it } from "vitest";

import {
  RemoteTeammateSessionMetadataSchema,
  createCollabAvatarIdentity,
} from "./protocol";
import { COLLAB_IDENTITY_KIND } from "./types";

describe("collaboration protocol helpers", () => {
  it("creates deterministic lightweight avatar identities", () => {
    expect(createCollabAvatarIdentity("Ada Lovelace").initials).toBe("AL");
    expect(["v", "h"]).toContain(
      createCollabAvatarIdentity("Ada Lovelace").variant
    );
  });

  it("round-trips repoScopeKey through the session metadata schema (design §8.3)", () => {
    const base = {
      id: "org-1:m1:session-1",
      orgId: "org-1",
      ownerMemberId: "m1",
      ownerUserId: "m1",
      ownerDisplayName: "Ada",
      ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
      sourceSessionId: "session-1",
      title: "Session",
      repoPath: "/owners/machine/checkout",
    };

    // The key survives the parse untouched — it rides in the opaque session
    // payload jsonb; the server never interprets it.
    const withKey = RemoteTeammateSessionMetadataSchema.parse({
      ...base,
      repoScopeKey: "github.com/acme/alpha",
      ownerAvatarUrl: "https://example.com/ada.png",
    });
    expect(withKey.repoScopeKey).toBe("github.com/acme/alpha");
    expect(withKey.ownerAvatarUrl).toBe("https://example.com/ada.png");

    // Old-client rows (key absent) and null-scrubbed jsonb both parse to
    // undefined — the consumer treats them as out of every scope.
    expect(
      RemoteTeammateSessionMetadataSchema.parse(base).repoScopeKey
    ).toBeUndefined();
    expect(
      RemoteTeammateSessionMetadataSchema.parse({ ...base, repoScopeKey: null })
        .repoScopeKey
    ).toBeUndefined();
  });

  it("parses typed external provenance while keeping old rows compatible", () => {
    const base = {
      id: "org-1:m1:session-1",
      orgId: "org-1",
      ownerMemberId: "m1",
      ownerUserId: "m1",
      ownerDisplayName: "Ada",
      ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
      sourceSessionId: "session-1",
      title: "Session",
    };
    expect(
      RemoteTeammateSessionMetadataSchema.parse({
        ...base,
        origin: { kind: "external_history", source: "claude_code" },
      }).origin
    ).toEqual({ kind: "external_history", source: "claude_code" });
    expect(
      RemoteTeammateSessionMetadataSchema.parse(base).origin
    ).toBeUndefined();
    expect(() =>
      RemoteTeammateSessionMetadataSchema.parse({
        ...base,
        origin: { kind: "external_history", source: "unknown" },
      })
    ).toThrow();
  });

  it("parses the 0014 comment counters additively (session comments)", () => {
    const base = {
      id: "org-1:m1:session-1",
      orgId: "org-1",
      ownerMemberId: "m1",
      ownerUserId: "m1",
      ownerDisplayName: "Ada",
      ownerIdentityKind: COLLAB_IDENTITY_KIND.HUMAN,
      sourceSessionId: "session-1",
      title: "Session",
    };

    const withCounts = RemoteTeammateSessionMetadataSchema.parse({
      ...base,
      commentCount: 4,
      unresolvedCommentCount: 2,
    });
    expect(withCounts.commentCount).toBe(4);
    expect(withCounts.unresolvedCommentCount).toBe(2);

    // Pre-0014 backends (fields absent) and null-scrubbed jsonb both parse
    // to undefined — no badge, no crash.
    const withoutCounts = RemoteTeammateSessionMetadataSchema.parse(base);
    expect(withoutCounts.commentCount).toBeUndefined();
    expect(withoutCounts.unresolvedCommentCount).toBeUndefined();
    const nulled = RemoteTeammateSessionMetadataSchema.parse({
      ...base,
      commentCount: null,
      unresolvedCommentCount: null,
    });
    expect(nulled.commentCount).toBeUndefined();
    expect(nulled.unresolvedCommentCount).toBeUndefined();
  });
});
