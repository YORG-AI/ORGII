import { describe, expect, it } from "vitest";

import type { ConversationSenderIdentity } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { SessionImportedFrom } from "@src/store/session";

import {
  resolveOrg2ConversationEventSender,
  resolveOrg2ConversationSourceSender,
} from "./Org2ConversationSenderMetadataProvider";

function remoteRow(
  overrides: Partial<RemoteTeammateSessionMetadata> = {}
): RemoteTeammateSessionMetadata {
  return {
    id: "row-1",
    orgId: "org-1",
    ownerMemberId: "member-1",
    ownerUserId: "user-1",
    ownerDisplayName: "Current Account Name",
    ownerAvatarUrl: "https://example.com/current.png",
    ownerIdentityKind: "human",
    sourceSessionId: "source-1",
    title: "Shared session",
    eventsEpoch: undefined,
    eventsFrozenSeq: undefined,
    eventsCount: undefined,
    eventsTailHash: undefined,
    ...overrides,
  };
}

function importedFrom(
  overrides: Partial<SessionImportedFrom> = {}
): SessionImportedFrom {
  return {
    orgId: "org-1",
    sourceSessionId: "source-1",
    ownerMemberId: "member-1",
    epoch: 1,
    seq: 2,
    count: 3,
    ...overrides,
  };
}

describe("resolveOrg2ConversationSourceSender", () => {
  it("combines persisted lineage with the authoritative source account row", () => {
    expect(
      resolveOrg2ConversationSourceSender({
        importedFrom: importedFrom({ ownerDisplayName: "Historical Name" }),
        rows: [remoteRow()],
      })
    ).toEqual({
      userId: "user-1",
      displayName: "Historical Name",
      avatarUrl: "https://example.com/current.png",
    });
  });

  it("uses the loading source before a local session row exists", () => {
    expect(
      resolveOrg2ConversationSourceSender({
        rows: [],
        loadingSource: remoteRow({
          ownerDisplayName: "Loading Owner",
          ownerAvatarUrl: undefined,
        }),
      })
    ).toEqual({ userId: "user-1", displayName: "Loading Owner" });
  });

  it("returns null for genuinely unknown unstamped history", () => {
    expect(resolveOrg2ConversationSourceSender({ rows: [] })).toBeNull();
  });
});

describe("resolveOrg2ConversationEventSender", () => {
  it("enriches a stamped remote id from the known account map", () => {
    const accounts = new Map<string, ConversationSenderIdentity>([
      [
        "user-2",
        {
          userId: "user-2",
          displayName: "Grace Hopper",
          avatarUrl: "https://example.com/grace.png",
        },
      ],
    ]);

    expect(
      resolveOrg2ConversationEventSender({ userId: "user-2" }, accounts, null)
    ).toEqual({
      userId: "user-2",
      displayName: "Grace Hopper",
      avatarUrl: "https://example.com/grace.png",
    });
  });

  it("keeps event-time presentation ahead of account fallback", () => {
    const accounts = new Map<string, ConversationSenderIdentity>([
      ["user-2", { userId: "user-2", displayName: "Current Name" }],
    ]);

    expect(
      resolveOrg2ConversationEventSender(
        { userId: "user-2", displayName: "Event Name" },
        accounts,
        null
      )
    ).toEqual({ userId: "user-2", displayName: "Event Name" });
  });
});
