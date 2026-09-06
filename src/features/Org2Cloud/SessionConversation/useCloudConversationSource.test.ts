import { describe, expect, it } from "vitest";

import { cloudConversationAuthorityIsLive } from "./cloudConversationAuthority";
import { conversationSourceFromCloudReplay } from "./useCloudConversationSource";

describe("Cloud conversation source", () => {
  it("projects source runtime before the imported Session row exists", () => {
    expect(
      conversationSourceFromCloudReplay({
        orgId: "org-1",
        remoteSession: {
          id: "row-1",
          orgId: "org-1",
          ownerMemberId: "member-ada",
          ownerUserId: "user-ada",
          ownerDisplayName: "Ada Lovelace",
          ownerIdentityKind: "human",
          sourceSessionId: "claude-source",
          title: "Runtime migration",
          cliAgentType: "claude_code",
          model: "claude-opus-5",
          eventsEpoch: 1,
          eventsFrozenSeq: 8,
          eventsCount: 24,
          eventsTailHash: "tail",
        },
        workspaceRepoPath: null,
      })
    ).toEqual({
      root: {
        authority: "org2-cloud",
        authorityScope: ["org-1"],
        conversationId: "claude-source",
      },
      cliAgentType: "claude_code",
      agentDefinitionId: undefined,
      agentDisplayName: undefined,
      model: "claude-opus-5",
      initialTarget: null,
      workspaceRepoPath: null,
    });
  });

  it("uses the resolved comment plane as the canonical Cloud root", () => {
    expect(
      conversationSourceFromCloudReplay({
        target: { orgId: "org-1", sessionId: "live-family-anchor" },
        remoteSession: {
          id: "row-1",
          orgId: "org-1",
          ownerMemberId: "member-ada",
          ownerUserId: "user-ada",
          ownerDisplayName: "Ada Lovelace",
          ownerIdentityKind: "human",
          sourceSessionId: "live-family-anchor",
          title: "Runtime migration",
          forkedFrom: {
            sourceSessionId: "expired-parent",
            rootSessionId: "expired-root",
            forkedAt: "2026-08-29T00:00:00.000Z",
          },
          eventsEpoch: 1,
          eventsFrozenSeq: 8,
          eventsCount: 24,
          eventsTailHash: "tail",
        },
        workspaceRepoPath: "/local/repo",
      })?.root
    ).toEqual({
      authority: "org2-cloud",
      authorityScope: ["org-1"],
      conversationId: "live-family-anchor",
    });
  });

  describe("owner-local Cloud authority liveness", () => {
    const target = { orgId: "org-1", sessionId: "local-root" };
    const row = { sourceSessionId: "local-root" } as never;

    it("keeps the Cloud authority while the root row is listed", () => {
      expect(
        cloudConversationAuthorityIsLive({
          session: { importedFrom: undefined },
          target,
          entry: { state: "ready", rows: [row] },
          loadingSource: null,
        })
      ).toBe(true);
    });

    it("keeps the Cloud authority until the listing has loaded", () => {
      expect(
        cloudConversationAuthorityIsLive({
          session: { importedFrom: undefined },
          target,
          entry: { state: "loading", rows: [] },
          loadingSource: null,
        })
      ).toBe(true);
      expect(
        cloudConversationAuthorityIsLive({
          session: { importedFrom: undefined },
          target,
          entry: undefined,
          loadingSource: null,
        })
      ).toBe(true);
    });

    it("drops the Cloud authority for a local session whose root row expired", () => {
      expect(
        cloudConversationAuthorityIsLive({
          session: { importedFrom: undefined },
          target,
          entry: { state: "ready", rows: [] },
          loadingSource: null,
        })
      ).toBe(false);
    });

    it("never drops the Cloud authority of a replay viewer", () => {
      expect(
        cloudConversationAuthorityIsLive({
          session: {
            importedFrom: {
              orgId: "org-1",
              sourceSessionId: "local-root",
            } as never,
          },
          target,
          entry: { state: "ready", rows: [] },
          loadingSource: null,
        })
      ).toBe(true);
      expect(
        cloudConversationAuthorityIsLive({
          session: undefined,
          target,
          entry: { state: "ready", rows: [] },
          loadingSource: { orgId: "org-1" },
        })
      ).toBe(true);
    });
  });
});
