import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  publishTurnIntentDispatch,
  resetTurnIntentDispatchLifecycleForTests,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  beginTurnDispatch,
  markTurnTerminal,
  resetTurnLifecycleForTests,
} from "@src/engines/SessionCore/control/turnLifecycle";
import * as forkSession from "@src/features/TeamCollaboration/forkSession";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import type { AddressableThread } from "./addressComments";
import {
  type ActiveAddressRun,
  addressRunActiveAtom,
  attachAnchorExcerpts,
  replyViaActiveAddressRun,
  runAddressCommentsRound,
  seedActiveAddressRunForTest,
} from "./addressCommentsRun";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import {
  addSessionComment,
  listSessionComments,
} from "./org2CloudCommentsClient";
import type { CloudSessionComment } from "./org2CloudCommentsClient";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: { getPersistedEvents: vi.fn(async () => []) },
}));
vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: vi.fn(async (state: unknown) => state),
}));
vi.mock("./org2CloudCommentsClient", () => ({
  listSessionComments: vi.fn(),
  addSessionComment: vi.fn(async () => undefined),
}));
vi.mock("./org2CloudCommentsBus", () => ({
  broadcastCommentsChanged: vi.fn(),
}));

function thread(
  overrides: Partial<AddressableThread> & Pick<AddressableThread, "headId">
): AddressableThread {
  return {
    headAuthor: "Alice",
    headBody: `body of ${overrides.headId}`,
    replies: [],
    scope: "session",
    ...overrides,
  };
}

function comment(
  overrides: Partial<CloudSessionComment> & Pick<CloudSessionComment, "id">
): CloudSessionComment {
  return {
    sessionId: "cloud-session-1",
    authorUserId: "user-1",
    authorDisplayName: "Alice",
    body: `body of ${overrides.id}`,
    createdAt: "2026-07-11T09:00:00Z",
    ...overrides,
  } as CloudSessionComment;
}

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.co",
  supabaseAnonKey: "anon",
  userId: "u",
  accessToken: "jwt-1",
  refreshToken: "rt-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  vi.clearAllMocks();
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudAuthAtom, AUTH);
  resetTurnLifecycleForTests();
  resetTurnIntentDispatchLifecycleForTests();
});

describe("attachAnchorExcerpts", () => {
  it("maps imported event ids back to the source round and user message", () => {
    const result = attachAnchorExcerpts(
      [thread({ headId: "c-1", scope: "round", anchorEventId: "evt-a" })],
      [
        { id: "local-1~evt-user", source: "user", displayText: "fix auth" },
        { id: "local-1~evt-a", source: "assistant", displayText: "done" },
      ],
      "local-1"
    );
    expect(result[0]).toMatchObject({
      anchorExcerpt: "fix auth",
      anchorRoundNumber: 1,
    });
  });

  it("does not mutate a missing anchor", () => {
    const original = thread({
      headId: "c-1",
      scope: "round",
      anchorEventId: "missing",
    });
    expect(attachAnchorExcerpts([original], [])[0]).toBe(original);
  });
});

describe("replyViaActiveAddressRun", () => {
  it("posts one agent_report and rejects duplicate replies", async () => {
    const run: ActiveAddressRun = {
      orgId: "org-1",
      cloudSessionId: "cloud-session-1",
      localSessionId: "local-1",
      validHeadIds: new Set(["c-1"]),
      replied: new Map(),
    };
    const cleanup = seedActiveAddressRunForTest(run);
    try {
      expect(
        await replyViaActiveAddressRun("c-1", " fixed ", "local-1")
      ).toMatchObject({ success: true });
      expect(vi.mocked(addSessionComment)).toHaveBeenCalledWith("jwt-1", {
        orgId: "org-1",
        sessionId: "cloud-session-1",
        parentId: "c-1",
        body: "fixed",
        kind: "agent_report",
      });
      expect(
        await replyViaActiveAddressRun("c-1", "again", "local-1")
      ).toMatchObject({ success: false });
    } finally {
      cleanup();
    }
  });

  it("fails closed across sessions and without trusted invocation context", async () => {
    const run: ActiveAddressRun = {
      orgId: "org-1",
      cloudSessionId: "local-1",
      localSessionId: "local-1",
      validHeadIds: new Set(["c-1"]),
      replied: new Map(),
    };
    const cleanup = seedActiveAddressRunForTest(run);
    try {
      expect(await replyViaActiveAddressRun("c-1", "x")).toMatchObject({
        success: false,
      });
      expect(
        await replyViaActiveAddressRun("c-1", "x", "local-2")
      ).toMatchObject({ success: false });
      expect(addSessionComment).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });
});

describe("runAddressCommentsRound", () => {
  it("submits through the supplied user-intent dispatcher and waits for its exact terminal", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1", body: "@agent fix this" })],
      viewerOwnsSession: true,
    });
    let dispatchedAgentContent = "";
    const result = await runAddressCommentsRound({
      orgId: "org-1",
      cloudSessionId: "local-1",
      localSessionId: "local-1",
      selectedHeadIds: ["c-1"],
      dispatchTurn: async ({ displayContent, agentContent, turnIntentId }) => {
        expect(
          getInstrumentedStore().get(addressRunActiveAtom)["local-1"]
        ).toEqual({ selectedHeadIds: ["c-1"] });
        expect(displayContent).toBe("@agent fix this");
        dispatchedAgentContent = agentContent;
        const generation = beginTurnDispatch("local-1");
        publishTurnIntentDispatch(turnIntentId, {
          sessionId: "local-1",
          generation,
        });
        setTimeout(
          () => markTurnTerminal("local-1", "completed", { generation }),
          0
        );
      },
    });
    expect(dispatchedAgentContent).toContain("id: c-1");
    expect(result).toEqual({ status: "ran", threadCount: 1, replyCount: 0 });
    expect(
      getInstrumentedStore().get(addressRunActiveAtom)["local-1"]
    ).toBeUndefined();
  });

  it("registers the run before dispatch so an immediate tool reply succeeds", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1" })],
      viewerOwnsSession: true,
    });
    const result = await runAddressCommentsRound({
      orgId: "org-1",
      cloudSessionId: "local-1",
      localSessionId: "local-1",
      dispatchTurn: async ({ turnIntentId }) => {
        const generation = beginTurnDispatch("local-1");
        publishTurnIntentDispatch(turnIntentId, {
          sessionId: "local-1",
          generation,
        });
        await replyViaActiveAddressRun("c-1", "done", "local-1");
        markTurnTerminal("local-1", "completed", { generation });
      },
    });
    expect(result).toEqual({ status: "ran", threadCount: 1, replyCount: 1 });
  });

  it("does not dispatch when no unresolved selected thread exists", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1", resolvedAt: "2026-07-11T10:00:00Z" })],
      viewerOwnsSession: true,
    });
    const dispatchTurn = vi.fn();
    await expect(
      runAddressCommentsRound({
        orgId: "org-1",
        cloudSessionId: "local-1",
        localSessionId: "local-1",
        dispatchTurn,
      })
    ).resolves.toEqual({ status: "no_threads" });
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it("fails before dispatch when the server says the viewer is not the session owner", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1" })],
      viewerOwnsSession: false,
    });
    const dispatchTurn = vi.fn();

    await expect(
      runAddressCommentsRound({
        orgId: "org-1",
        cloudSessionId: "cloud-session-1",
        localSessionId: "cloud-session-1",
        dispatchTurn,
      })
    ).rejects.toThrow(/owner's source session/);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it("fails before dispatch when a writable fork targets its parent's comments", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1" })],
      viewerOwnsSession: true,
    });
    const dispatchTurn = vi.fn();

    await expect(
      runAddressCommentsRound({
        orgId: "org-1",
        cloudSessionId: "cloud-session-1",
        localSessionId: "fork-session-1",
        dispatchTurn,
      })
    ).rejects.toThrow(/verified local fork/);
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it("allows a verified local fork to address its owner's source comments", async () => {
    vi.mocked(listSessionComments).mockResolvedValue({
      comments: [comment({ id: "c-1" })],
      viewerOwnsSession: true,
    });
    const provenance = vi
      .spyOn(forkSession, "getSessionForkedFrom")
      .mockReturnValue({
        orgId: "org-1",
        sourceSessionId: "cloud-session-1",
        ownerMemberId: "member-1",
        ownerDisplayName: "Alice",
        atCount: 1,
        forkedAt: "2026-07-19T00:00:00.000Z",
      });
    try {
      await expect(
        runAddressCommentsRound({
          orgId: "org-1",
          cloudSessionId: "cloud-session-1",
          localSessionId: "fork-session-1",
          dispatchTurn: async ({ turnIntentId }) => {
            const generation = beginTurnDispatch("fork-session-1");
            publishTurnIntentDispatch(turnIntentId, {
              sessionId: "fork-session-1",
              generation,
            });
            markTurnTerminal("fork-session-1", "completed", { generation });
          },
        })
      ).resolves.toEqual({
        status: "ran",
        threadCount: 1,
        replyCount: 0,
      });
    } finally {
      provenance.mockRestore();
    }
  });
});
