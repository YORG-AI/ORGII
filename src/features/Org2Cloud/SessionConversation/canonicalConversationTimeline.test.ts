import { describe, expect, it, vi } from "vitest";

import { CONVERSATION_SENDER_ARG } from "@src/engines/SessionCore/conversations/conversationSenderMetadata";
import {
  NATIVE_SOURCE_EVENT_ID_ARG,
  projectNativeConversationItems,
} from "@src/engines/SessionCore/conversations/nativeConversationMaterializer";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import type { CloudSessionComment } from "../org2CloudCommentsClient";
import type { CloudConversationEvent } from "../org2CloudConversationEventsClient";
import {
  CanonicalConversationFamilyUnavailableError,
  MAX_CANONICAL_FAMILY_LOAD_CONCURRENCY,
  assembleCanonicalConversationTimeline,
  legacyConversationFamilyForTimeline,
  loadCanonicalConversationTimeline,
} from "./canonicalConversationTimeline";
import {
  type ConversationFamilyMember,
  resolveConversationFamily,
} from "./continuationEvents";

function event(
  id: string,
  source: "user" | "assistant",
  createdAt: string,
  turnIntentId?: string
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: "local",
    createdAt,
    functionName: source === "user" ? "user_message" : "assistant_message",
    uiCanonical: source === "user" ? "user_message" : "assistant_message",
    actionType: source === "user" ? "raw" : "assistant",
    args: {},
    result: {
      ...(source === "user"
        ? { type: "user", message: { role: "user", content: id } }
        : { observation: id }),
      ...(turnIntentId ? { turnIntentId } : {}),
    },
    source,
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

function remoteRow(
  overrides: Partial<RemoteTeammateSessionMetadata>
): RemoteTeammateSessionMetadata {
  return {
    id: "row-root",
    orgId: "org-1",
    ownerMemberId: "member-a",
    ownerUserId: "alice",
    ownerDisplayName: "Alice",
    ownerIdentityKind: "org_member",
    sourceSessionId: "root",
    title: "Conversation",
    eventsEpoch: 1,
    eventsFrozenSeq: 0,
    eventsCount: 2,
    eventsTailHash: "tail",
    ...overrides,
  } as RemoteTeammateSessionMetadata;
}

const rootRow = remoteRow({});
const forkRow = remoteRow({
  id: "row-fork",
  ownerMemberId: "member-b",
  ownerUserId: "bob",
  ownerDisplayName: "Bob",
  sourceSessionId: "fork",
  forkedFrom: {
    sourceSessionId: "root",
    rootSessionId: "root",
    forkedAt: "2026-08-20T10:00:00Z",
  },
});
const family = resolveConversationFamily([rootRow, forkRow], "root");
if (!family) throw new Error("family fixture missing");

const rootEvents = [
  event("root-user", "user", "2026-08-20T09:00:00Z"),
  event("root-answer", "assistant", "2026-08-20T09:01:00Z"),
];
const currentTurn = event(
  "optimistic-current",
  "user",
  "2026-08-20T11:00:00Z",
  "turn-current"
);
const forkEvents = [
  ...rootEvents.map((item) => ({ ...item, id: `fork~${item.id}` })),
  event("fork-user", "user", "2026-08-20T10:01:00Z"),
  event("fork-answer", "assistant", "2026-08-20T10:02:00Z"),
  currentTurn,
];
const planeEvents: CloudConversationEvent[] = [
  {
    id: "plane-current",
    rootSessionId: "root",
    authorUserId: "alice",
    authorDisplayName: "Alice",
    turnId: "turn-current",
    seq: 1,
    event: { ...currentTurn, id: "plane-current-user" },
    createdAt: currentTurn.createdAt,
  },
];
const comments: CloudSessionComment[] = [
  {
    id: "comment-1",
    authorUserId: "carol",
    authorDisplayName: "Carol",
    body: "team context",
    createdAt: "2026-08-20T10:03:00Z",
    mentionedUserIds: ["bob"],
  },
];

const common = {
  family,
  anchorBareSessionId: "root",
  planeEvents,
  comments,
  streamSessionId: "surface",
  viewer: { status: "known" as const, userId: "alice" },
};

describe("canonical conversation timeline", () => {
  it("gives UI assembly and execution loading the identical canonical base", async () => {
    const eventsByBareSessionId = new Map([
      ["root", rootEvents],
      ["fork", forkEvents],
    ]);
    const uiBase = assembleCanonicalConversationTimeline({
      ...common,
      anchorEvents: rootEvents,
      eventsByBareSessionId,
    });
    const loadMemberEvents = vi.fn(
      async (bareSessionId: string) =>
        eventsByBareSessionId.get(bareSessionId) ?? null
    );
    const executionBase = await loadCanonicalConversationTimeline({
      ...common,
      loadMemberEvents,
    });

    expect(executionBase).toEqual(uiBase);
    expect(loadMemberEvents).toHaveBeenCalledTimes(2);
    // Both pre-plane family segments survive; inherited root copies do not.
    expect(executionBase.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "root-user",
        "root-answer",
        "fork-user",
        "fork-answer",
      ])
    );
    expect(executionBase.some((item) => item.id === "fork~root-user")).toBe(
      false
    );
    // Optimistic/local and plane copies collapse by turn id. The continuation
    // core's existing send-once boundary excludes this turn before native
    // materialization and appends it through the provider exactly once.
    expect(
      executionBase.filter(
        (item) =>
          (item.result as { turnIntentId?: string }).turnIntentId ===
          "turn-current"
      )
    ).toHaveLength(1);
  });

  it("collapses exact global source copies on the family-less execution path", async () => {
    const repeatedSourceId = "orgii_evt_0c2481a309205d2abd70fd14234cf0f5";
    const original = {
      ...event("codex-asst-97", "assistant", "2026-08-20T09:00:00Z"),
      sessionId: "native-codex",
      args: { [NATIVE_SOURCE_EVENT_ID_ARG]: repeatedSourceId },
      displayText: "same answer",
    };
    const replay = {
      ...event("claude-renumbered-14", "assistant", "2026-08-20T09:00:00Z"),
      sessionId: "native-claude",
      args: { [NATIVE_SOURCE_EVENT_ID_ARG]: repeatedSourceId },
      displayText: "same answer",
    };
    const distinct = {
      ...event("claude-new-15", "assistant", "2026-08-20T09:01:00Z"),
      sessionId: "native-claude",
      args: {
        [NATIVE_SOURCE_EVENT_ID_ARG]:
          "orgii_evt_11111111111111111111111111111111",
      },
      // Identical content must not cause semantic deduplication.
      displayText: "same answer",
    };

    const timeline = await loadCanonicalConversationTimeline({
      ...common,
      family: null,
      planeEvents: [],
      comments: [],
      loadMemberEvents: async () => [original, replay, distinct],
    });

    expect(timeline).toEqual([original, distinct]);
    expect(projectNativeConversationItems(timeline)).toHaveLength(2);
  });

  it("keeps Team Chat as a portable user row with sender metadata", () => {
    const timeline = assembleCanonicalConversationTimeline({
      ...common,
      anchorEvents: rootEvents,
      eventsByBareSessionId: new Map([
        ["root", rootEvents],
        ["fork", forkEvents],
      ]),
    });
    const discussion = timeline.find(
      (item) => item.id === "session-discussion-comment-1"
    );
    expect(discussion).toMatchObject({
      source: "user",
      displayText: "team context",
      args: {
        [CONVERSATION_SENDER_ARG]: {
          userId: "carol",
          displayName: "Carol",
        },
        sessionDiscussion: {
          mentionedUserIds: ["bob"],
        },
      },
    });
  });

  it("replaces a provider-native Team Chat echo with the Cloud discussion row", () => {
    const initial = assembleCanonicalConversationTimeline({
      ...common,
      family: null,
      planeEvents: [],
      anchorEvents: [],
    });
    const [nativeDiscussion] = projectNativeConversationItems(initial);
    if (!nativeDiscussion)
      throw new Error("discussion fixture did not project");
    const nativeEcho = {
      ...event(
        "codex-user-echo",
        "user",
        "2026-08-20T10:03:00Z",
        "provider-turn"
      ),
      sessionId: "native-codex",
      args: { [NATIVE_SOURCE_EVENT_ID_ARG]: nativeDiscussion.id },
      displayText: "team context",
      result: {
        type: "user",
        message: { role: "user", content: "team context" },
        turnIntentId: "provider-turn",
      },
    } as SessionEvent;

    const timeline = assembleCanonicalConversationTimeline({
      ...common,
      family: null,
      planeEvents: [],
      anchorEvents: [nativeEcho],
    });

    expect(projectNativeConversationItems(timeline)).toHaveLength(1);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "session-discussion-comment-1",
      args: {
        [CONVERSATION_SENDER_ARG]: {
          userId: "carol",
          displayName: "Carol",
        },
        sessionDiscussion: {
          mentionedUserIds: ["bob"],
        },
      },
    });
  });

  it("fails closed instead of silently omitting a required family member", async () => {
    await expect(
      loadCanonicalConversationTimeline({
        ...common,
        loadMemberEvents: async (bareSessionId) =>
          bareSessionId === "root" ? rootEvents : null,
      })
    ).rejects.toEqual(
      expect.objectContaining<
        Partial<CanonicalConversationFamilyUnavailableError>
      >({ bareSessionId: "fork" })
    );
  });

  it("treats post-plane forks as execution episodes rather than transcript sources", async () => {
    const postPlane = remoteRow({
      id: "row-post-plane",
      sourceSessionId: "post-plane",
      ownerUserId: "carol",
      ownerDisplayName: "Carol",
      forkedFrom: {
        sourceSessionId: "fork",
        rootSessionId: "root",
        forkedAt: "2026-08-20T12:00:00Z",
      },
    });
    const extended = resolveConversationFamily(
      [rootRow, forkRow, postPlane],
      "root"
    );
    expect(
      legacyConversationFamilyForTimeline(
        extended,
        "root",
        planeEvents,
        "2026-08-20T11:00:00Z"
      )?.map((member) => member.bareSessionId)
    ).toEqual(["root", "fork"]);

    const loadMemberEvents = vi.fn(async (bareSessionId: string) =>
      bareSessionId === "root" ? rootEvents : forkEvents
    );
    await loadCanonicalConversationTimeline({
      ...common,
      family: extended,
      planeHistoryStartedAt: "2026-08-20T11:00:00Z",
      loadMemberEvents,
    });
    expect(loadMemberEvents.mock.calls.map(([id]) => id)).not.toContain(
      "post-plane"
    );
  });

  it("bounds compatibility family reads after loading the anchor first", async () => {
    const members: ConversationFamilyMember[] = Array.from(
      { length: 10 },
      (_, index) => ({
        bareSessionId: index === 0 ? "root" : `legacy-${index}`,
        isRoot: index === 0,
        row: remoteRow({
          id: `row-${index}`,
          sourceSessionId: index === 0 ? "root" : `legacy-${index}`,
          forkedFrom:
            index === 0
              ? undefined
              : {
                  sourceSessionId: "root",
                  rootSessionId: "root",
                  forkedAt: "2026-08-20T09:30:00Z",
                },
        }),
      })
    );
    let active = 0;
    let peak = 0;
    const loadMemberEvents = vi.fn(async (bareSessionId: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return bareSessionId === "root" ? rootEvents : [];
    });

    await loadCanonicalConversationTimeline({
      ...common,
      family: members,
      loadMemberEvents,
    });

    expect(loadMemberEvents.mock.calls[0]?.[0]).toBe("root");
    expect(peak).toBeLessThanOrEqual(MAX_CANONICAL_FAMILY_LOAD_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
