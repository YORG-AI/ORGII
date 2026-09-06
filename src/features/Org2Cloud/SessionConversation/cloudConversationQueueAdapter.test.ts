import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  QueuedConversationBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnClosedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { Org2CloudConversationError } from "@src/features/Org2Cloud/org2CloudConversationEventsClient";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { sessionsAtom } from "@src/store/session";

import { dispatchQueuedCloudConversation } from "./cloudConversationQueueAdapter";

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(),
  capabilities: vi.fn(),
  pushEvents: vi.fn(),
  refreshPlane: vi.fn(),
  runConversationTurn: vi.fn(),
  listComments: vi.fn(),
  loadCanonical: vi.fn(),
  importRemote: vi.fn(),
  buildFetchClient: vi.fn(),
  cloudDeviceIdentity: vi.fn(),
  admitTurn: vi.fn(),
  claimTurn: vi.fn(),
  renewTurn: vi.fn(),
  markAccepted: vi.fn(),
  finishTurn: vi.fn(),
}));

vi.mock("@src/api/tauri/cloudDevice", () => ({
  cloudDeviceIdentity: mocks.cloudDeviceIdentity,
}));

vi.mock(
  "@src/engines/SessionCore/conversations/canonicalConversationEvents",
  () => ({ loadCanonicalConversationEvents: mocks.loadCanonical })
);

vi.mock("@src/features/Org2Cloud/org2CloudCommentsClient", () => ({
  listSessionComments: mocks.listComments,
}));

vi.mock("@src/features/Org2Cloud/org2CloudBackendAdapter", () => ({
  buildCloudSessionFetchClient: mocks.buildFetchClient,
}));

vi.mock("@src/features/TeamCollaboration/engine/collabSessionImport", () => ({
  importRemoteSession: mocks.importRemote,
}));

vi.mock("@src/features/Org2Cloud/org2CloudAuthAction", () => ({
  refreshOrg2CloudAuthForAction: mocks.refreshAuth,
}));

vi.mock("@src/features/Org2Cloud/org2CloudCapabilities", () => ({
  getCloudCapabilitiesConfirmed: mocks.capabilities,
}));

vi.mock("@src/features/Org2Cloud/org2CloudConversationTurnClient", () => ({
  admitCloudConversationTurn: mocks.admitTurn,
  claimCloudConversationTurn: mocks.claimTurn,
  renewCloudConversationTurn: mocks.renewTurn,
  markCloudConversationTurnAccepted: mocks.markAccepted,
  finishCloudConversationTurn: mocks.finishTurn,
}));

vi.mock(
  "@src/features/Org2Cloud/org2CloudConversationEventsClient",
  async (importOriginal) => ({
    ...(await importOriginal()),
    pushConversationEventsChunked: mocks.pushEvents,
  })
);

vi.mock("./conversationPlaneAtom", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshConversationPlaneEntry: mocks.refreshPlane,
}));

vi.mock("./conversationTurnRunner", async (importOriginal) => ({
  ...(await importOriginal()),
  runConversationTurn: mocks.runConversationTurn,
}));

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_000_000_000,
};

const REFRESHED_AUTH = {
  ...AUTH,
  accessToken: "access-after-plane-refresh",
  refreshToken: "refresh-after-plane-refresh",
};

const ROOT = {
  authority: "org2-cloud" as const,
  authorityScope: ["https://cloud.example", "org-1"],
  conversationId: "shared-root",
};

const MESSAGE = {
  id: "message-1",
  turnIntentId: "turn-1",
  sessionId: "imported-session",
  content: "continue",
  displayContent: "continue",
  status: "preparing" as const,
  conversationDispatch: {
    kind: "canonical_conversation" as const,
    root: ROOT,
    target: {
      cliAgentType: "codex" as const,
      accountId: "openai-1",
      model: "gpt-5.6-sol",
    },
    dispatchIdentityKey: "https://cloud.example|user-1",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refreshAuth.mockImplementation(async (auth) => ({
    status: "ready",
    auth,
  }));
  mocks.capabilities.mockResolvedValue({
    confirmed: true,
    capabilities: {
      conversationEvents: true,
      conversationEventsIdempotency: true,
      conversationTurnCoordination: false,
    },
  });
  mocks.pushEvents.mockResolvedValue({ firstSeq: 1, lastSeq: 1 });
  mocks.listComments.mockResolvedValue({ comments: [] });
  mocks.buildFetchClient.mockReturnValue({});
  mocks.importRemote.mockResolvedValue({
    localSessionId: "imported-fork",
    updated: true,
  });
  mocks.refreshPlane.mockResolvedValue({ state: "ready", events: [] });
  mocks.cloudDeviceIdentity.mockResolvedValue({
    deviceId: "11111111-1111-4111-8111-111111111111",
    machineLabel: "test-mac",
  });
  mocks.admitTurn.mockResolvedValue({
    turnId: "turn-1",
    enqueueSeq: 1,
    status: "queued",
    firstSeq: 1,
    lastSeq: 1,
  });
  mocks.claimTurn.mockResolvedValue({
    outcome: "claimed",
    turnId: "turn-1",
    status: "claimed",
    enqueueSeq: 1,
    leaseExpiresAt: "2026-09-05T10:00:30.000Z",
  });
  mocks.renewTurn.mockResolvedValue({
    turnId: "turn-1",
    status: "claimed",
    leaseExpiresAt: "2026-09-05T10:00:40.000Z",
  });
  mocks.markAccepted.mockResolvedValue({
    turnId: "turn-1",
    status: "accepted",
    acceptedAt: "2026-09-05T10:00:01.000Z",
    leaseExpiresAt: "2026-09-05T10:00:31.000Z",
  });
  mocks.finishTurn.mockResolvedValue({
    turnId: "turn-1",
    status: "completed",
    finishedAt: "2026-09-05T10:00:02.000Z",
  });
  mocks.loadCanonical.mockImplementation(async (sessionId: string) => ({
    source: "native_store",
    events:
      sessionId === "root"
        ? [
            {
              id: "root-pre-plane",
              chunk_id: "root-pre-plane",
              sessionId,
              createdAt: "2026-08-20T09:00:00Z",
              functionName: "assistant_message",
              uiCanonical: "assistant_message",
              actionType: "assistant",
              args: {},
              result: {},
              source: "assistant",
              displayText: "root history",
              displayStatus: "completed",
              displayVariant: "message",
              activityStatus: "agent",
              payloadRefs: [],
            },
          ]
        : [
            {
              id: "fork-pre-plane",
              chunk_id: "fork-pre-plane",
              sessionId,
              createdAt: "2026-08-20T10:00:00Z",
              functionName: "assistant_message",
              uiCanonical: "assistant_message",
              actionType: "assistant",
              args: {},
              result: {},
              source: "assistant",
              displayText: "fork history",
              displayStatus: "completed",
              displayVariant: "message",
              activityStatus: "agent",
              payloadRefs: [],
            },
          ],
  }));
});

function readyStore() {
  const store = createStore();
  store.set(org2CloudAuthAtom, AUTH);
  store.set(org2CloudRemoteSessionsAtom, {
    "org-1": {
      identityKey: "https://cloud.example|user-1",
      state: "ready",
      fetchedAt: 1,
      rows: [
        {
          id: "row-root",
          orgId: "org-1",
          ownerMemberId: "member-1",
          ownerUserId: "user-1",
          ownerDisplayName: "Owner",
          ownerIdentityKind: "human",
          sourceSessionId: "shared-root",
          title: "Root",
          eventsEpoch: 1,
          eventsFrozenSeq: 0,
          eventsCount: 0,
          eventsTailHash: "root-tail",
        },
      ],
    },
  });
  return store;
}

function enableTurnCoordination() {
  mocks.capabilities.mockResolvedValue({
    confirmed: true,
    capabilities: {
      conversationEvents: true,
      conversationEventsIdempotency: true,
      conversationTurnCoordination: true,
    },
  });
}

const ASSISTANT_TAIL_EVENT = {
  id: "assistant-tail",
  chunk_id: "assistant-tail",
  sessionId: "runner",
  createdAt: "2026-09-05T10:00:02.000Z",
  functionName: "assistant_message",
  uiCanonical: "assistant_message",
  actionType: "assistant",
  args: {},
  result: {},
  source: "assistant",
  displayText: "done",
  displayStatus: "completed",
  displayVariant: "message",
  activityStatus: "agent",
  payloadRefs: [],
} as const;

describe("dispatchQueuedCloudConversation coordination", () => {
  it("atomically admits the exact user event instead of using the old push path", async () => {
    enableTurnCoordination();
    mocks.runConversationTurn.mockImplementationOnce(async (params) => {
      await params.onBeforeTurnDispatch?.("runner");
      await params.onTurnAccepted?.("runner");
      return { runnerSessionId: "runner", terminalStatus: "completed" };
    });

    await dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(mocks.admitTurn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        orgId: "org-1",
        rootSessionId: "shared-root",
        turnId: "turn-1",
        event: expect.objectContaining({
          source: "user",
          result: expect.objectContaining({ turnIntentId: "turn-1" }),
        }),
      }),
      expect.any(Object)
    );
    expect(mocks.pushEvents).not.toHaveBeenCalled();
    expect(mocks.finishTurn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "completed" }),
      expect.any(Object)
    );
  });

  it("fails closed when one user event would require non-atomic wire chunks", async () => {
    enableTurnCoordination();

    await expect(
      dispatchQueuedCloudConversation(
        readyStore(),
        {
          ...MESSAGE,
          content: "x".repeat(70_000),
          displayContent: "x".repeat(70_000),
        },
        ROOT,
        { onAccepted: vi.fn() }
      )
    ).rejects.toBeInstanceOf(QueuedConversationBlockedError);

    expect(mocks.admitTurn).not.toHaveBeenCalled();
    expect(mocks.pushEvents).not.toHaveBeenCalled();
    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
  });

  it("returns a waiting claim to the existing queue retry owner", async () => {
    enableTurnCoordination();
    mocks.claimTurn.mockResolvedValueOnce({
      outcome: "waiting",
      turnId: "turn-1",
      status: "queued",
      enqueueSeq: 2,
      headTurnId: "turn-ahead",
      headStatus: "accepted",
      retryAfterMs: 1000,
    });

    await expect(
      dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
    expect(mocks.markAccepted).not.toHaveBeenCalled();
    expect(mocks.finishTurn).not.toHaveBeenCalled();
  });

  it("retains the active owner when admission succeeded but claim reconciliation fails", async () => {
    enableTurnCoordination();
    mocks.claimTurn.mockRejectedValueOnce(
      Object.assign(new Error("claim conflict"), { status: 409 })
    );

    await expect(
      dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.admitTurn).toHaveBeenCalledOnce();
    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
    expect(mocks.finishTurn).not.toHaveBeenCalled();
  });

  it("reclaims the same turn after reload and reconnects its accepted runner", async () => {
    enableTurnCoordination();
    const onAccepted = vi.fn();
    mocks.runConversationTurn.mockResolvedValueOnce({
      runnerSessionId: "runner-reload",
      terminalStatus: "completed",
    });

    await dispatchQueuedCloudConversation(
      readyStore(),
      {
        ...MESSAGE,
        status: "accepted",
        runnerSessionId: "runner-reload",
        runnerEventStartIndex: 17,
      },
      ROOT,
      { onAccepted }
    );

    expect(mocks.claimTurn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        turnId: "turn-1",
        deviceId: "11111111-1111-4111-8111-111111111111",
      }),
      expect.any(Object)
    );
    expect(mocks.markAccepted).toHaveBeenCalledOnce();
    expect(onAccepted).toHaveBeenCalledWith("runner-reload");
    expect(mocks.runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: {
          runnerSessionId: "runner-reload",
          eventStartIndex: 17,
          providerAccepted: true,
        },
      })
    );
  });

  it("does not treat a recovered Cloud acceptance as local provider acceptance", async () => {
    enableTurnCoordination();
    const order: string[] = [];
    const onAccepted = vi.fn(async () => {
      order.push("provider-accepted");
    });
    mocks.claimTurn.mockResolvedValueOnce({
      outcome: "accepted",
      turnId: "turn-1",
      status: "accepted",
      enqueueSeq: 1,
      acceptedAt: "2026-09-05T10:00:01.000Z",
      leaseExpiresAt: "2026-09-05T10:00:31.000Z",
    });
    mocks.runConversationTurn.mockImplementationOnce(async (params) => {
      order.push("runner-recovery");
      expect(params.recovery).toEqual({
        runnerSessionId: "runner-preparing",
        eventStartIndex: 17,
        providerAccepted: false,
      });
      await params.onTurnAccepted?.("runner-preparing");
      return {
        runnerSessionId: "runner-preparing",
        terminalStatus: "completed",
      };
    });

    await dispatchQueuedCloudConversation(
      readyStore(),
      {
        ...MESSAGE,
        runnerSessionId: "runner-preparing",
        runnerEventStartIndex: 17,
      },
      ROOT,
      { onAccepted }
    );

    expect(order).toEqual(["runner-recovery", "provider-accepted"]);
    expect(onAccepted).toHaveBeenCalledOnce();
  });

  it("marks the Cloud lease accepted immediately before provider dispatch", async () => {
    enableTurnCoordination();
    const order: string[] = [];
    mocks.markAccepted.mockImplementationOnce(async () => {
      order.push("accepted");
      return {
        turnId: "turn-1",
        status: "accepted",
        acceptedAt: "2026-09-05T10:00:01.000Z",
        leaseExpiresAt: "2026-09-05T10:00:31.000Z",
      };
    });
    mocks.runConversationTurn.mockImplementationOnce(async (params) => {
      await params.onBeforeTurnDispatch?.("runner");
      order.push("provider");
      await params.onTurnAccepted?.("runner");
      return { runnerSessionId: "runner", terminalStatus: "completed" };
    });

    await dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(order).toEqual(["accepted", "provider"]);
  });

  it("publishes the provider tail before finishing the Cloud ledger row", async () => {
    enableTurnCoordination();
    const order: string[] = [];
    mocks.pushEvents.mockImplementation(async () => {
      order.push("publish");
      return { firstSeq: 2, lastSeq: 2 };
    });
    mocks.finishTurn.mockImplementationOnce(async () => {
      order.push("finish");
      return {
        turnId: "turn-1",
        status: "completed",
        finishedAt: "2026-09-05T10:00:02.000Z",
      };
    });
    mocks.runConversationTurn.mockImplementationOnce(async (params) => {
      await params.onBeforeTurnDispatch?.("runner");
      await params.onTurnAccepted?.("runner");
      await params.publishTail("turn-1", [ASSISTANT_TAIL_EVENT]);
      return { runnerSessionId: "runner", terminalStatus: "completed" };
    });

    await dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(order).toEqual(["publish", "finish"]);
  });

  it("owns one bounded renewal timer and clears it when the turn finishes", async () => {
    vi.useFakeTimers();
    try {
      enableTurnCoordination();
      let finishProvider: (() => void) | undefined;
      mocks.runConversationTurn.mockImplementationOnce(async (params) => {
        await params.onBeforeTurnDispatch?.("runner");
        await params.onTurnAccepted?.("runner");
        await new Promise<void>((resolve) => {
          finishProvider = resolve;
        });
        return { runnerSessionId: "runner", terminalStatus: "completed" };
      });

      const dispatch = dispatchQueuedCloudConversation(
        readyStore(),
        MESSAGE,
        ROOT,
        { onAccepted: vi.fn() }
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.renewTurn).toHaveBeenCalledOnce();
      finishProvider?.();
      await dispatch;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.renewTurn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the original push workflow when the capability is disabled", async () => {
    mocks.runConversationTurn.mockResolvedValueOnce({
      runnerSessionId: "runner",
      terminalStatus: "completed",
    });

    await dispatchQueuedCloudConversation(readyStore(), MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(mocks.pushEvents).toHaveBeenCalledOnce();
    expect(mocks.cloudDeviceIdentity).not.toHaveBeenCalled();
    expect(mocks.admitTurn).not.toHaveBeenCalled();
    expect(mocks.claimTurn).not.toHaveBeenCalled();
    expect(mocks.renewTurn).not.toHaveBeenCalled();
    expect(mocks.markAccepted).not.toHaveBeenCalled();
    expect(mocks.finishTurn).not.toHaveBeenCalled();
  });
});

describe("dispatchQueuedCloudConversation failure classification", () => {
  it("uses auth committed by the plane refresh for every later Cloud read", async () => {
    const store = readyStore();
    mocks.refreshPlane.mockImplementationOnce(async ({ setAuth }) => {
      setAuth(REFRESHED_AUTH);
      return { state: "ready", events: [] };
    });
    mocks.runConversationTurn.mockResolvedValueOnce({
      runnerSessionId: "runner",
      terminalStatus: "completed",
    });

    await dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(mocks.listComments).toHaveBeenCalledWith(
      REFRESHED_AUTH.accessToken,
      "org-1",
      "shared-root",
      {
        endpoint: {
          supabaseUrl: REFRESHED_AUTH.supabaseUrl,
          anonKey: REFRESHED_AUTH.supabaseAnonKey,
        },
      }
    );
    expect(mocks.buildFetchClient).toHaveBeenCalledWith(
      REFRESHED_AUTH.accessToken,
      expect.objectContaining({ anonKey: REFRESHED_AUTH.supabaseAnonKey })
    );
    expect(mocks.pushEvents).toHaveBeenCalledWith(
      REFRESHED_AUTH.accessToken,
      expect.objectContaining({ turnId: "turn-1" }),
      expect.objectContaining({
        supabaseUrl: REFRESHED_AUTH.supabaseUrl,
        anonKey: REFRESHED_AUTH.supabaseAnonKey,
      })
    );
  });

  it("publishes one terminal event and closes after a definitive post-admission 4xx", async () => {
    const store = readyStore();
    mocks.runConversationTurn.mockRejectedValueOnce(
      new Org2CloudConversationError("ORG2_FORBIDDEN", 403)
    );

    await expect(
      dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationTurnClosedError);

    expect(mocks.pushEvents).toHaveBeenCalledTimes(2);
    expect(mocks.pushEvents.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        turnId: "turn-1",
        events: [
          expect.objectContaining({
            source: "system",
            displayStatus: "failed",
          }),
        ],
      })
    );
    expect(mocks.runConversationTurn).toHaveBeenCalledOnce();
  });

  it("retains recovery ownership after a retryable post-admission 5xx", async () => {
    const store = readyStore();
    mocks.runConversationTurn.mockRejectedValueOnce(
      new Org2CloudConversationError("temporary upstream failure", 503)
    );

    await expect(
      dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);

    expect(mocks.pushEvents).toHaveBeenCalledOnce();
    expect(mocks.runConversationTurn).toHaveBeenCalledOnce();
  });

  it("leaves an already-bound native suffix to accepted-turn recovery", async () => {
    const store = readyStore();
    mocks.runConversationTurn.mockResolvedValueOnce({
      runnerSessionId: "runner-accepted",
      terminalStatus: "completed",
    });

    await dispatchQueuedCloudConversation(
      store,
      {
        ...MESSAGE,
        status: "accepted",
        runnerSessionId: "runner-accepted",
        runnerEventStartIndex: 42,
      },
      ROOT,
      { onAccepted: vi.fn() }
    );

    expect(mocks.pushEvents).toHaveBeenCalledOnce();
    expect(mocks.runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        recovery: {
          runnerSessionId: "runner-accepted",
          eventStartIndex: 42,
          providerAccepted: true,
        },
      })
    );
  });

  it("fails a local shared session visibly once its Cloud root row is gone", async () => {
    enableTurnCoordination();
    const store = readyStore();
    store.set(sessionsAtom, [
      {
        session_id: "shared-root",
        name: "Root",
        status: "completed",
        created_at: "2026-08-20T09:00:00Z",
        updated_at: "2026-08-20T09:00:00Z",
      },
    ]);
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: "https://cloud.example|user-1",
        state: "ready",
        fetchedAt: 1,
        rows: [],
      },
    });

    await expect(
      dispatchQueuedCloudConversation(
        store,
        { ...MESSAGE, sessionId: "shared-root" },
        ROOT,
        { onAccepted: vi.fn() }
      )
    ).rejects.toBeInstanceOf(QueuedConversationBlockedError);

    expect(mocks.admitTurn).not.toHaveBeenCalled();
    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
  });

  it("fails a replay viewer's send when the ready Cloud listing has no root", async () => {
    enableTurnCoordination();
    const store = readyStore();
    store.set(sessionsAtom, [
      {
        session_id: "imported-session",
        name: "Root",
        status: "completed",
        created_at: "2026-08-20T09:00:00Z",
        updated_at: "2026-08-20T09:00:00Z",
        importedFrom: {
          orgId: "org-1",
          sourceSessionId: "shared-root",
          sourceEndpointUrl: "https://cloud.example",
          ownerMemberId: "member-1",
          epoch: 1,
          seq: 0,
          count: 0,
        },
      },
    ]);
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: "https://cloud.example|user-1",
        state: "ready",
        fetchedAt: 1,
        rows: [],
      },
    });

    await expect(
      dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationBlockedError);
    expect(mocks.admitTurn).not.toHaveBeenCalled();
    expect(mocks.claimTurn).not.toHaveBeenCalled();
    expect(mocks.pushEvents).not.toHaveBeenCalled();
    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
  });

  it("keeps an unhydrated Cloud listing recovery-pending without dispatching", async () => {
    enableTurnCoordination();
    const store = readyStore();
    store.set(org2CloudRemoteSessionsAtom, {});

    await expect(
      dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
        onAccepted: vi.fn(),
      })
    ).rejects.toBeInstanceOf(QueuedConversationRecoveryPendingError);
    expect(mocks.admitTurn).not.toHaveBeenCalled();
    expect(mocks.runConversationTurn).not.toHaveBeenCalled();
  });

  it("imports every available family member before executing the canonical timeline", async () => {
    const store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
    store.set(sessionsAtom, [
      {
        session_id: "shared-root",
        name: "Root",
        status: "completed",
        created_at: "2026-08-20T09:00:00Z",
        updated_at: "2026-08-20T09:00:00Z",
      },
    ]);
    store.set(org2CloudRemoteSessionsAtom, {
      "org-1": {
        identityKey: "https://cloud.example|user-1",
        state: "ready",
        fetchedAt: 1,
        rows: [
          {
            id: "row-root",
            orgId: "org-1",
            ownerMemberId: "member-1",
            ownerUserId: "user-1",
            ownerDisplayName: "Owner",
            ownerIdentityKind: "human",
            sourceSessionId: "shared-root",
            title: "Root",
            eventsEpoch: 1,
            eventsFrozenSeq: 0,
            eventsCount: 1,
            eventsTailHash: "root-tail",
          },
          {
            id: "row-fork",
            orgId: "org-1",
            ownerMemberId: "member-2",
            ownerUserId: "user-2",
            ownerDisplayName: "Teammate",
            ownerIdentityKind: "human",
            sourceSessionId: "fork-1",
            title: "Fork",
            eventsEpoch: 1,
            eventsFrozenSeq: 0,
            eventsCount: 1,
            eventsTailHash: "fork-tail",
            forkedFrom: {
              sourceSessionId: "shared-root",
              rootSessionId: "shared-root",
              forkedAt: "2026-08-20T10:00:00Z",
            },
          },
        ],
      },
    });
    mocks.loadCanonical.mockImplementation(async (sessionId: string) => ({
      source: "native_store",
      events: [
        {
          id:
            sessionId === "imported-fork" ? "fork-pre-plane" : "root-pre-plane",
          chunk_id: "chunk",
          sessionId,
          createdAt:
            sessionId === "imported-fork"
              ? "2026-08-20T10:00:00Z"
              : "2026-08-20T09:00:00Z",
          functionName: "assistant_message",
          uiCanonical: "assistant_message",
          actionType: "assistant",
          args: {},
          result: {},
          source: "assistant",
          displayText: sessionId,
          displayStatus: "completed",
          displayVariant: "message",
          activityStatus: "agent",
          payloadRefs: [],
        },
      ],
    }));
    mocks.refreshPlane.mockResolvedValue({
      state: "ready",
      events: [],
    });
    mocks.listComments.mockResolvedValue({
      comments: [
        {
          id: "discussion-1",
          authorUserId: "user-2",
          authorDisplayName: "Teammate",
          body: "team context",
          createdAt: "2026-08-20T10:01:00Z",
        },
      ],
    });
    mocks.runConversationTurn.mockResolvedValue({
      runnerSessionId: "runner",
      terminalStatus: "completed",
    });

    await dispatchQueuedCloudConversation(store, MESSAGE, ROOT, {
      onAccepted: vi.fn(),
    });

    expect(mocks.importRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        remoteSession: expect.objectContaining({ sourceSessionId: "fork-1" }),
      })
    );
    const timeline = mocks.runConversationTurn.mock.calls[0]?.[0]
      ?.timeline as Array<{ id: string; source: string; args: unknown }>;
    expect(timeline.map((event) => event.id)).toEqual(
      expect.arrayContaining([
        "root-pre-plane",
        "fork-pre-plane",
        "session-discussion-discussion-1",
      ])
    );
    expect(
      timeline.find((event) => event.id === "session-discussion-discussion-1")
    ).toMatchObject({
      source: "user",
      args: {
        conversationSender: {
          userId: "user-2",
          displayName: "Teammate",
        },
      },
    });
  });
});
