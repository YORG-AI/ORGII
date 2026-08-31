import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  CONVERSATION_SENDER_ARG,
  resolveConversationFamily,
  stitchConversationSegments,
} from "./continuationEvents";

function row(
  overrides: Partial<RemoteTeammateSessionMetadata>
): RemoteTeammateSessionMetadata {
  return {
    id: "row-1",
    orgId: "org-1",
    ownerMemberId: "m-1",
    ownerUserId: "u-1",
    ownerDisplayName: "Alice",
    sourceSessionId: "root-1",
    eventsEpoch: 1,
    eventsCount: 10,
    lastActivityAt: "2026-08-20T09:00:00Z",
    ...overrides,
  } as RemoteTeammateSessionMetadata;
}

function evt(id: string, createdAt: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "local-1",
    createdAt,
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {},
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

const rootRow = row({ id: "row-root", sourceSessionId: "root-1" });
const forkB = row({
  id: "row-b",
  sourceSessionId: "fork-b",
  ownerUserId: "u-b",
  ownerDisplayName: "Bob",
  forkedFrom: {
    sourceSessionId: "root-1",
    rootSessionId: "root-1",
    forkedAt: "2026-08-20T10:00:00Z",
  },
});
const forkC = row({
  id: "row-c",
  sourceSessionId: "fork-c",
  ownerUserId: "u-c",
  ownerDisplayName: "Cara",
  forkedFrom: {
    sourceSessionId: "root-1",
    rootSessionId: "root-1",
    forkedAt: "2026-08-20T11:00:00Z",
  },
});

describe("resolveConversationFamily", () => {
  it("orders root first then forks by fork time, from any anchor", () => {
    const fromRoot = resolveConversationFamily(
      [forkC, rootRow, forkB],
      "root-1"
    );
    expect(fromRoot?.map((member) => member.bareSessionId)).toEqual([
      "root-1",
      "fork-b",
      "fork-c",
    ]);
    const fromFork = resolveConversationFamily(
      [forkC, rootRow, forkB],
      "fork-c"
    );
    expect(fromFork?.map((member) => member.bareSessionId)).toEqual([
      "root-1",
      "fork-b",
      "fork-c",
    ]);
  });

  it("returns null for sessions without a fork family", () => {
    expect(resolveConversationFamily([rootRow], "root-1")).toBeNull();
    expect(resolveConversationFamily([rootRow, forkB], "unrelated")).toBeNull();
  });
});

describe("stitchConversationSegments", () => {
  const family = resolveConversationFamily([rootRow, forkB, forkC], "root-1");
  if (!family) throw new Error("fixture family missing");

  it("joins loaded segments seamlessly, stamping senders instead of dividers", () => {
    const anchorEvents = [evt("root-e1", "2026-08-20T09:00:00Z")];
    const bobUser = {
      ...evt("bob-u1", "2026-08-20T10:04:00Z"),
      source: "user" as const,
    };
    const bobReply = evt("bob-e1", "2026-08-20T10:05:00Z");
    const stitched = stitchConversationSegments(
      family,
      "root-1",
      anchorEvents,
      new Map([["fork-b", [bobUser, bobReply]]])
    );
    // fork-c has no local copy: it contributes nothing here — the
    // background family import streams it in later, no placeholder row.
    expect(stitched.map((event) => event.id)).toEqual([
      "root-e1",
      "bob-u1",
      "bob-e1",
    ]);
    expect(stitched[0].args[CONVERSATION_SENDER_ARG]).toBeUndefined();
    expect(stitched[1].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "u-b",
      displayName: "Bob",
    });
    expect(stitched[2].args[CONVERSATION_SENDER_ARG]).toBeUndefined();
  });

  it("uses the anchor transcript for a fork viewpoint and stamps the root segment", () => {
    const forkView = stitchConversationSegments(
      family,
      "fork-b",
      [evt("bob-local-e1", "2026-08-20T10:05:00Z")],
      new Map([
        [
          "root-1",
          [
            {
              ...evt("root-u1", "2026-08-20T08:59:00Z"),
              source: "user" as const,
            },
            evt("root-e1", "2026-08-20T09:00:00Z"),
          ],
        ],
      ])
    );
    expect(forkView.map((event) => event.id)).toEqual([
      "root-u1",
      "root-e1",
      "bob-local-e1",
    ]);
    expect(forkView[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "u-1",
      displayName: "Alice",
    });
    expect(forkView[2].args[CONVERSATION_SENDER_ARG]).toBeUndefined();
  });

  it("drops a native fork's inherited copies and keeps root attribution", () => {
    // Native org2 forks copy the parent transcript; the copies carry
    // namespaced ids (`<localSessionId>~<sourceId>`). Only fork-b's NEW
    // turn may survive, and the surviving "who asked" row must keep the
    // ROOT owner's stamp, not the fork owner's.
    const rootUser = {
      ...evt("root-u1", "2026-08-20T08:59:00Z"),
      source: "user" as const,
    };
    const rootReply = evt("root-e1", "2026-08-20T09:00:00Z");
    const inheritedUser = {
      ...rootUser,
      id: "local-b~root-u1",
      chunk_id: "local-b~root-u1",
      sessionId: "local-b",
    };
    const inheritedReply = {
      ...rootReply,
      id: "local-b~root-e1",
      chunk_id: "local-b~root-e1",
      sessionId: "local-b",
    };
    const bobNewUser = {
      ...evt("bob-u2", "2026-08-20T10:04:00Z"),
      sessionId: "local-b",
      source: "user" as const,
    };
    const stitched = stitchConversationSegments(
      family,
      "root-1",
      [rootUser, rootReply],
      new Map([["fork-b", [inheritedUser, inheritedReply, bobNewUser]]])
    );
    expect(stitched.map((event) => event.id)).toEqual([
      "root-u1",
      "root-e1",
      "bob-u2",
    ]);
    expect(stitched[0].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "u-1",
      displayName: "Alice",
    });
    expect(stitched[2].args[CONVERSATION_SENDER_ARG]).toEqual({
      userId: "u-b",
      displayName: "Bob",
    });
  });

  it("keeps inherited copies when the root segment is not loaded", () => {
    const inheritedUser = {
      ...evt("local-b~root-u1", "2026-08-20T08:59:00Z"),
      sessionId: "local-b",
      source: "user" as const,
    };
    const familyNoRootCopy = resolveConversationFamily(
      [rootRow, forkB, forkC],
      "fork-b"
    );
    if (!familyNoRootCopy) throw new Error("fixture family missing");
    const stitched = stitchConversationSegments(
      familyNoRootCopy,
      "fork-b",
      [inheritedUser],
      new Map()
    );
    expect(stitched.map((event) => event.id)).toContain("local-b~root-u1");
  });
});
