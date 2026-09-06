// @vitest-environment jsdom
/**
 * End-to-end seam for a NON-edited Team Chat retry: the real comments atom,
 * the real `SessionCommentsContext.retryComment` owner, the real canonical
 * discussion projection, and the real `useUserMessageDeliveryActions`
 * adapter that `UserChatItem` renders its failed/retry chrome from.
 *
 * The sibling suites each mock one half of that chain (the atom suite mocks
 * the wire, the context suite mocks the atom), so neither proves that a
 * successful retry actually removes the failed row from the rendered
 * projection — the invariant the rendered dual-instance C3 scenario asserts.
 */
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUserMessageDeliveryActions } from "@src/engines/ChatPanel/ChatItems/useUserMessageDeliveryActions";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { assembleCanonicalConversationTimeline } from "../SessionConversation/canonicalConversationTimeline";
import type { Org2CloudAuthState } from "../org2CloudAuthAtom";
import { org2CloudAuthAtom } from "../org2CloudAuthAtom";
import type { CloudSessionComment } from "../org2CloudCommentsClient";
import { org2CloudSessionCommentsAtom } from "../org2CloudSessionCommentsAtom";
import {
  type SessionCommentsContextValue,
  SessionCommentsProvider,
  useSessionCommentsContext,
} from "./SessionCommentsContext";

const mocks = vi.hoisted(() => ({
  addSessionComment: vi.fn(),
  listSessionComments: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
  getCloudCapabilities: vi.fn(),
  ownerRun: vi.fn(),
}));

vi.mock("../org2CloudCommentsClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org2CloudCommentsClient")>()),
  addSessionComment: mocks.addSessionComment,
  listSessionComments: mocks.listSessionComments,
}));

vi.mock("../org2CloudSessionCommentsAtom.freshToken", () => ({
  useCloudFreshAccessToken: () => async () => "access-token",
}));

vi.mock("../org2CloudCommentsBus", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../org2CloudCommentsBus")>()),
  broadcastCommentsChangedToPeers: vi.fn(),
}));

vi.mock("../sessionCommentTarget", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessionCommentTarget")>()),
  useSessionCommentTarget: (
    _session: unknown,
    targetOverride?: { orgId: string; sessionId: string } | null
  ) => targetOverride ?? null,
}));

vi.mock("../org2CloudMembersCoordinator", () => ({
  loadCloudOrgMembers: mocks.loadCloudOrgMembers,
}));

vi.mock("../org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("../useOwnedCloudCommentAgentRun", () => ({
  useOwnedCloudCommentAgentRun: () => ({
    available: false,
    run: mocks.ownerRun,
  }),
}));

const FAILED_TESTID = "chat-message-delivery-failed";
const PENDING_TESTID = "chat-message-delivery-pending";

const auth: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "viewer",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_000_000_000,
};

let rowRetry: (() => void) | null = null;

function deliveryStatusOf(
  event: SessionEvent
): "pending" | "sent" | "failed" | null {
  const raw = (event.result as Record<string, unknown> | undefined)
    ?.deliveryStatus;
  if (raw === "pending" || raw === "sent" || raw === "failed") return raw;
  if (event.displayStatus === "pending") return "pending";
  if (event.displayStatus === "failed") return "failed";
  return null;
}

const ProjectedRow = ({ event }: { event: SessionEvent }) => {
  const deliveryStatus = deliveryStatusOf(event);
  const actions = useUserMessageDeliveryActions({ event, deliveryStatus });
  useEffect(() => {
    if (deliveryStatus === "failed") rowRetry = actions.retry;
  });
  return createElement("li", {
    "data-testid":
      deliveryStatus === "failed"
        ? FAILED_TESTID
        : deliveryStatus === "pending"
          ? PENDING_TESTID
          : "chat-message-delivery-sent",
  });
};

const ProjectedTranscript = () => {
  const comments = useSessionCommentsContext();
  const timeline = assembleCanonicalConversationTimeline({
    family: null,
    anchorBareSessionId: "session-1",
    anchorEvents: [],
    planeEvents: [],
    comments: comments?.comments ?? [],
    streamSessionId: "session-1",
    viewer: { viewerUserId: "viewer" } as never,
    ...(comments?.toSourceEventId
      ? { toSourceEventId: comments.toSourceEventId }
      : {}),
  });
  return createElement(
    "ul",
    null,
    timeline.map((event) =>
      createElement(ProjectedRow, { key: event.id, event })
    )
  );
};

describe("Team Chat failed row retry reaches the rendered projection", () => {
  let root: SmokeRoot | null = null;
  const store = createStore();

  beforeEach(() => {
    vi.clearAllMocks();
    rowRetry = null;
    store.set(org2CloudSessionCommentsAtom, {});
    store.set(org2CloudAuthAtom, auth);
    mocks.listSessionComments.mockResolvedValue({
      comments: [],
      viewerOwnsSession: true,
      serverTime: "2026-09-03T00:00:00Z",
    });
    mocks.loadCloudOrgMembers.mockResolvedValue({
      auth,
      members: [
        { userId: "bob", displayName: "Bob", role: "member", status: "active" },
      ],
    });
    mocks.getCloudCapabilities.mockResolvedValue({ teamInboxMentions: true });
  });

  afterEach(async () => {
    await root?.unmount();
    root = null;
  });

  it("clears the failed projection when an offline send is retried online", async () => {
    let context: SessionCommentsContextValue | null = null;
    const CaptureContext = () => {
      const value = useSessionCommentsContext();
      useEffect(() => {
        context = value;
      }, [value]);
      return null;
    };
    root = createSmokeRoot();
    await root.render(
      createElement(
        Provider,
        { store },
        createElement(
          SessionCommentsProvider,
          {
            session: null,
            targetOverride: { orgId: "org-1", sessionId: "session-1" },
            events: null,
          },
          createElement(CaptureContext),
          createElement(ProjectedTranscript)
        )
      )
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const container = root.container;
    const countOf = (testId: string) =>
      container.querySelectorAll(`[data-testid="${testId}"]`).length;

    mocks.addSessionComment.mockRejectedValueOnce(new TypeError("Load failed"));
    await act(async () => {
      await (context as unknown as SessionCommentsContextValue)
        .addComment({ body: "hello @Bob", mentionedUserIds: ["bob"] })
        .catch(() => undefined);
    });

    expect(countOf(FAILED_TESTID)).toBe(1);
    expect(rowRetry).toBeTypeOf("function");

    const delivered: CloudSessionComment = {
      id: "server-comment-1",
      authorUserId: "viewer",
      authorDisplayName: "Viewer",
      body: "hello @Bob",
      createdAt: "2026-09-03T00:00:05.000Z",
      kind: "user",
      mentionedUserIds: ["bob"],
    };
    mocks.addSessionComment.mockResolvedValueOnce(delivered);
    await act(async () => {
      rowRetry?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(countOf(FAILED_TESTID)).toBe(0);
    expect(countOf(PENDING_TESTID)).toBe(0);
    expect(mocks.addSessionComment).toHaveBeenCalledTimes(2);
    const retryPayload = mocks.addSessionComment.mock.calls[1][1];
    expect(retryPayload).toMatchObject({
      body: "hello @Bob",
      mentionedUserIds: ["bob"],
      clientMessageKey:
        mocks.addSessionComment.mock.calls[0][1].clientMessageKey,
      replaceExisting: false,
    });
    expect(retryPayload.expectedBody).toBeUndefined();
    expect(
      store.get(org2CloudSessionCommentsAtom)["org-1|session-1"]?.comments
    ).toEqual([delivered]);
  });
});
