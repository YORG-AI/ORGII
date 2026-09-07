// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { sessionCommentsKey } from "./org2CloudCommentsBus";
import type { CloudSessionComment } from "./org2CloudCommentsClient";
import {
  SessionCommentDeliveryError,
  org2CloudSessionCommentsAtom,
  useSessionComments,
} from "./org2CloudSessionCommentsAtom";

const mocks = vi.hoisted(() => ({
  addSessionComment: vi.fn(),
  listSessionComments: vi.fn(),
}));

vi.mock("./org2CloudCommentsClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./org2CloudCommentsClient")>();
  return {
    ...actual,
    addSessionComment: mocks.addSessionComment,
    listSessionComments: mocks.listSessionComments,
  };
});

vi.mock("./org2CloudSessionCommentsAtom.freshToken", () => ({
  useCloudFreshAccessToken: () => async () => "access-token",
}));

vi.mock("./org2CloudCommentsBus", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./org2CloudCommentsBus")>();
  return { ...actual, broadcastCommentsChangedToPeers: vi.fn() };
});

type CommentsApi = ReturnType<typeof useSessionComments>;
let api: CommentsApi;

function Harness({
  onReady,
  orgId = "org-1",
  sessionId = "session-1",
}: {
  onReady: (value: CommentsApi) => void;
  orgId?: string | null;
  sessionId?: string | null;
}) {
  const value = useSessionComments(orgId, sessionId);
  useEffect(() => onReady(value), [onReady, value]);
  return null;
}

const captureApi = (value: CommentsApi) => {
  api = value;
};

describe("Team Chat retained delivery", () => {
  let root: SmokeRoot;
  const store = createStore();

  beforeEach(async () => {
    vi.clearAllMocks();
    store.set(org2CloudSessionCommentsAtom, {});
    store.set(org2CloudAuthAtom, {
      kind: "org2_cloud",
      supabaseUrl: "https://cloud.example.com",
      supabaseAnonKey: "anon",
      userId: "user-1",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() / 1000 + 3600,
      profile: { displayName: "Alice" },
    });
    mocks.listSessionComments.mockResolvedValue({
      comments: [],
      viewerOwnsSession: true,
      serverTime: "2026-09-03T00:00:00Z",
    });
    root = createSmokeRoot();
    await root.render(
      createElement(
        Provider,
        { store },
        createElement(Harness, { onReady: captureApi })
      )
    );
    await act(async () => Promise.resolve());
  });

  afterEach(async () => root.unmount());

  it("retains a failed row, permits editing, and retries the same row", async () => {
    mocks.addSessionComment.mockRejectedValueOnce(new Error("offline"));
    let failure: unknown;
    await act(async () => {
      try {
        await api.addComment({
          body: "hello @Bob",
          mentionedUserIds: ["user-2"],
        });
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toBeInstanceOf(SessionCommentDeliveryError);
    const localId = (failure as SessionCommentDeliveryError).commentId;
    const key = sessionCommentsKey("org-1", "session-1");
    const readComments = () =>
      store.get(org2CloudSessionCommentsAtom)[key].comments;
    expect(readComments()).toContainEqual(
      expect.objectContaining({
        id: localId,
        body: "hello @Bob",
        mentionedUserIds: ["user-2"],
        clientDeliveryStatus: "failed",
        clientDeliveryError: "offline",
      })
    );
    const retainedAt = readComments()[0].createdAt;

    const delivered: CloudSessionComment = {
      id: "comment-1",
      authorUserId: "user-1",
      authorDisplayName: "Alice",
      body: "edited @Carol",
      createdAt: "2026-09-03T00:00:01Z",
      kind: "user",
      mentionedUserIds: ["user-3"],
    };
    let resolveSend!: (comment: CloudSessionComment) => void;
    mocks.addSessionComment.mockReturnValueOnce(
      new Promise<CloudSessionComment>((resolve) => {
        resolveSend = resolve;
      })
    );
    // Retry is not a second mechanism: the owning surface re-sends the same
    // row through addComment under its stable optimistic id.
    let retry!: Promise<CloudSessionComment>;
    await act(async () => {
      retry = api.addComment({
        body: "edited @Carol",
        mentionedUserIds: ["user-3"],
        optimisticId: localId,
        replaceExisting: true,
        expectedBody: "hello @Bob",
        expectedMentionedUserIds: ["user-2"],
      });
    });

    expect(mocks.addSessionComment).toHaveBeenLastCalledWith(
      "access-token",
      expect.objectContaining({
        body: "edited @Carol",
        mentionedUserIds: ["user-3"],
        clientMessageKey: localId,
        replaceExisting: true,
        expectedBody: "hello @Bob",
        expectedMentionedUserIds: ["user-2"],
      })
    );
    // The retained row is edited in place — never retracted, never re-dated.
    const pending = readComments();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: localId,
      body: "edited @Carol",
      mentionedUserIds: ["user-3"],
      createdAt: retainedAt,
      clientDeliveryStatus: "pending",
    });
    expect(pending[0].clientDeliveryError).toBeUndefined();

    await act(async () => {
      resolveSend(delivered);
      await retry;
    });
    expect(readComments()).toEqual([delivered]);
  });

  it("rejects without claiming ownership when no row was inserted", async () => {
    const targetless = createSmokeRoot();
    let targetlessApi!: CommentsApi;
    await targetless.render(
      createElement(
        Provider,
        { store },
        createElement(Harness, {
          orgId: null,
          sessionId: null,
          onReady: (value: CommentsApi) => {
            targetlessApi = value;
          },
        })
      )
    );
    await act(async () => Promise.resolve());

    await expect(
      targetlessApi.addComment({ body: "hello" })
    ).rejects.not.toBeInstanceOf(SessionCommentDeliveryError);
    expect(mocks.addSessionComment).not.toHaveBeenCalled();
    await targetless.unmount();
  });
});
