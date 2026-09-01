// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type MobileRemoteContextValue,
  MobileRemoteProviders,
  type MobileRemoteProvidersProps,
  useMobileRemote,
} from "./MobileRemoteProviders";

const TestMobileRemoteProviders = MobileRemoteProviders as React.ComponentType<
  React.PropsWithChildren<Omit<MobileRemoteProvidersProps, "children">>
>;

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  close: vi.fn(),
  notificationHandler: null as
    | ((method: string, params?: Record<string, unknown>) => void)
    | null,
  sendParams: null as Record<string, unknown> | null,
  externalRoundId: null as string | null,
}));

vi.mock("../connection/mobileRpcClient", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../connection/mobileRpcClient")>();
  return {
    ...original,
    createMobileRpcClient: () => ({
      call: mocks.call,
      notify: vi.fn(),
      onNotification: (
        handler: (method: string, params?: Record<string, unknown>) => void
      ) => {
        mocks.notificationHandler = handler;
        return () => {
          if (mocks.notificationHandler === handler) {
            mocks.notificationHandler = null;
          }
        };
      },
      close: mocks.close,
      readyState: 1,
    }),
  };
});

class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;

  constructor(_url: string) {
    super();
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("MobileRemoteProviders send lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestContext: MobileRemoteContextValue | null;
  let sendResult: ReturnType<typeof deferred<{ execution: string }>>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  function Probe(): null {
    const context = useMobileRemote();
    React.useEffect(() => {
      latestContext = context;
    }, [context]);
    return null;
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  beforeEach(async () => {
    latestContext = null;
    sendResult = deferred<{ execution: string }>();
    mocks.sendParams = null;
    mocks.externalRoundId = null;
    mocks.notificationHandler = null;
    mocks.call
      .mockReset()
      .mockImplementation(
        (method: string, params?: Record<string, unknown>) => {
          if (method === "initialize") {
            return Promise.resolve({ protocolVersion: 1, tier: "full" });
          }
          if (method === "session/list") {
            return Promise.resolve({ sessions: [] });
          }
          if (method === "session/subscribe") {
            const externalRound = mocks.externalRoundId
              ? [
                  {
                    id: mocks.externalRoundId,
                    userPreview: "external turn",
                  },
                ]
              : [];
            return Promise.resolve({
              sessionId: params?.sessionId,
              rounds: {
                items: [
                  { id: "round-1", userPreview: "First" },
                  { id: "round-2", userPreview: "Second" },
                  { id: "round-3", userPreview: "Latest" },
                  ...externalRound,
                ],
                complete: true,
              },
              snapshot: {
                sessionId: params?.sessionId,
                roundId: mocks.externalRoundId ?? "round-3",
                version: 1,
                snapshotDelta: false,
                upserts: [],
              },
            });
          }
          if (method === "session/round") {
            const roundId = String(params?.roundId);
            return Promise.resolve({
              sessionId: params?.sessionId,
              roundId,
              snapshot: {
                sessionId: params?.sessionId,
                roundId,
                version: 1,
                snapshotDelta: false,
                upserts: [
                  {
                    id: `agent-${roundId}`,
                    source: "assistant",
                    displayVariant: "message",
                    displayText: `History ${roundId}`,
                  },
                ],
              },
            });
          }
          if (method === "session/send") {
            mocks.sendParams = params ?? null;
            return sendResult.promise;
          }
          return Promise.resolve({});
        }
      );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          TestMobileRemoteProviders,
          {
            authUserId: "user-a",
            demoByDefault: false,
            suppressInitialBootstrap: true,
          },
          React.createElement(Probe)
        )
      );
    });
    await act(async () => {
      await latestContext?.connectLive({
        wsUrl: "wss://relay.example.test/v1/mobile/ws",
      });
    });
    await act(async () => {
      await latestContext?.subscribeSession("session-a");
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders the user message before the send RPC is acknowledged and deduplicates its echo", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "visible now");
      await Promise.resolve();
    });

    expect(latestContext?.transcriptItems).toEqual([
      expect.objectContaining({
        kind: "user",
        text: "visible now",
        optimistic: true,
      }),
    ]);
    const turnIntentId = String(mocks.sendParams?.turnIntentId);

    await act(async () => {
      sendResult.resolve({ execution: "native_agent" });
      await pendingSend;
    });
    act(() => {
      mocks.notificationHandler?.("orgii/snapshot", {
        sessionId: "session-a",
        version: 2,
        snapshotDelta: true,
        upserts: [
          {
            id: "persisted-user",
            turnIntentId,
            source: "user",
            displayVariant: "message",
            displayText: "visible now",
          },
        ],
      });
    });

    expect(latestContext?.transcriptItems).toEqual([
      expect.objectContaining({
        id: "persisted-user",
        text: "visible now",
      }),
    ]);
    expect(latestContext?.transcriptItems.some((item) => item.optimistic)).toBe(
      false
    );
  });

  it("keeps the pending mobile question before an agent response that races ahead of its echo", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T12:00:00.000Z"));
    try {
      let pendingSend!: Promise<void>;
      await act(async () => {
        pendingSend = latestContext!.sendMessage("session-a", "question first");
        await Promise.resolve();
      });

      vi.setSystemTime(new Date("2026-08-30T12:00:01.000Z"));
      act(() => {
        mocks.notificationHandler?.("orgii/snapshot", {
          sessionId: "session-a",
          version: 2,
          snapshotDelta: true,
          upserts: [
            {
              id: "agent-response",
              source: "assistant",
              displayVariant: "message",
              displayText: "answer second",
              createdAt: "2026-08-30T12:00:01.000Z",
            },
          ],
        });
      });

      expect(latestContext?.transcriptItems).toEqual([
        expect.objectContaining({
          kind: "user",
          text: "question first",
          optimistic: true,
        }),
        expect.objectContaining({
          kind: "agent",
          text: "answer second",
        }),
      ]);

      await act(async () => {
        sendResult.resolve({ execution: "managed_cli" });
        await pendingSend;
      });
      const turnIntentId = String(mocks.sendParams?.turnIntentId);
      act(() => {
        mocks.notificationHandler?.("orgii/snapshot", {
          sessionId: "session-a",
          version: 3,
          snapshotDelta: true,
          upserts: [
            {
              id: "persisted-user",
              turnIntentId,
              source: "user",
              displayVariant: "message",
              displayText: "question first",
              createdAt: "2026-08-30T12:00:00.100Z",
            },
          ],
        });
      });

      expect(latestContext?.transcriptItems.map((item) => item.id)).toEqual([
        "persisted-user",
        "agent-response",
      ]);
      expect(
        latestContext?.transcriptItems.some((item) => item.optimistic)
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes the optimistic row when dispatch fails", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "retry me");
      void pendingSend.catch(() => undefined);
      await Promise.resolve();
    });
    expect(latestContext?.transcriptItems).toHaveLength(1);
    const turnIntentId = String(mocks.sendParams?.turnIntentId);

    act(() => {
      mocks.notificationHandler?.("orgii/snapshot", {
        sessionId: "session-a",
        version: 2,
        snapshotDelta: true,
        upserts: [
          {
            id: "failed-user-echo",
            turnIntentId,
            source: "user",
            displayVariant: "message",
            displayText: "retry me",
          },
        ],
      });
    });
    expect(latestContext?.transcriptItems).toEqual([
      expect.objectContaining({ id: "failed-user-echo" }),
    ]);
    expect(latestContext?.transcriptItems[0]).not.toHaveProperty("optimistic");

    await act(async () => {
      sendResult.reject(new Error("Relay rejected the message"));
      await expect(pendingSend).rejects.toThrow("Relay rejected the message");
    });

    expect(latestContext?.transcriptItems).toEqual([]);
    expect(latestContext?.activeRoundId).toBe("round-3");
    expect(latestContext?.transcriptRounds).toHaveLength(3);
    expect(latestContext?.sendStatus).toMatchObject({
      phase: "failed",
      message: "Relay rejected the message",
    });
  });

  it("returns after an external Codex acknowledgement when its terminal notification is lost", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "do not hang");
      await Promise.resolve();
    });

    await act(async () => {
      sendResult.resolve({ execution: "external_codex" });
      await pendingSend;
    });

    expect(latestContext?.sendStatus).toMatchObject({
      phase: "accepted",
      sessionId: "session-a",
    });
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "do not hang",
      optimistic: true,
    });
  });

  it("keeps an external provisional round when completion has no proven round id", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "external turn");
      await Promise.resolve();
    });
    const turnIntentId = String(mocks.sendParams?.turnIntentId);
    await act(async () => {
      sendResult.resolve({ execution: "external_codex" });
      await pendingSend;
    });
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "external turn",
      optimistic: true,
    });

    act(() => {
      mocks.notificationHandler?.("session/send_status", {
        sessionId: "session-a",
        turnIntentId,
        status: "completed",
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestContext?.sendStatus).toMatchObject({
      phase: "completed",
      turnIntentId,
    });
    expect(latestContext?.activeRoundId).toBe(`local-pending:${turnIntentId}`);
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "external turn",
      optimistic: true,
    });
  });

  it("promotes an external provisional round from an exact terminal round id", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "external turn");
      await Promise.resolve();
    });
    const turnIntentId = String(mocks.sendParams?.turnIntentId);
    await act(async () => {
      sendResult.resolve({ execution: "external_codex" });
      await pendingSend;
    });
    mocks.externalRoundId = "codex-user-42";

    act(() => {
      mocks.notificationHandler?.("session/send_status", {
        sessionId: "session-a",
        turnIntentId,
        status: "completed",
        roundId: mocks.externalRoundId,
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestContext?.sendStatus).toMatchObject({
      phase: "completed",
      turnIntentId,
    });
    expect(latestContext?.activeRoundId).toBe("codex-user-42");
    expect(latestContext?.transcriptRounds.map((round) => round.id)).toEqual([
      "round-1",
      "round-2",
      "round-3",
      "codex-user-42",
    ]);
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "external turn",
    });
  });

  it("keeps an accepted question when transport loss makes dispatch uncertain", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage(
        "session-a",
        "survive reconnect"
      );
      void pendingSend.catch(() => undefined);
      await Promise.resolve();
    });

    await act(async () => {
      sendResult.reject(new Error("WebSocket closed"));
      await pendingSend;
    });

    expect(latestContext?.sendStatus).toMatchObject({ phase: "uncertain" });
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "survive reconnect",
      optimistic: true,
    });
  });

  it("keeps session lifecycle callbacks stable across presence changes", () => {
    const initialSubscribe = latestContext?.subscribeSession;
    const initialUnsubscribe = latestContext?.unsubscribeSession;

    act(() => {
      mocks.notificationHandler?.("relay/presence", { online: false });
    });
    act(() => {
      mocks.notificationHandler?.("relay/presence", { online: true });
    });

    expect(latestContext?.subscribeSession).toBe(initialSubscribe);
    expect(latestContext?.unsubscribeSession).toBe(initialUnsubscribe);
  });

  it.each([
    {
      name: "CLI status",
      envelope: (turnIntentId: string) => ({
        type: "code_session.status_changed",
        session_id: "session-a",
        turn_intent_id: turnIntentId,
        status: "completed",
      }),
    },
    {
      name: "streaming completion",
      envelope: (turnIntentId: string) => ({
        type: "agent:streaming_complete",
        payload: {
          sessionId: "session-a",
          event: { result: { turnIntentId } },
        },
      }),
    },
    {
      name: "history invalidation",
      envelope: (turnIntentId: string) => ({
        type: "code_session.history_changed",
        session_id: "session-a",
        history_session_id: "cursorcliapp-history",
        status: "turn_settled",
        turn_intent_id: turnIntentId,
      }),
    },
  ])(
    "settles the managed send and refreshes history on $name",
    async ({ envelope }) => {
      let pendingSend!: Promise<void>;
      await act(async () => {
        pendingSend = latestContext!.sendMessage("session-a", "managed turn");
        await Promise.resolve();
      });
      const turnIntentId = String(mocks.sendParams?.turnIntentId);
      await act(async () => {
        sendResult.resolve({ execution: "managed_cli" });
        await pendingSend;
      });
      expect(latestContext?.sendStatus?.phase).toBe("accepted");
      const subscribeCallsBefore = mocks.call.mock.calls.filter(
        ([method]) => method === "session/subscribe"
      ).length;

      act(() => {
        mocks.notificationHandler?.("orgii/event", {
          sessionId: "session-a",
          envelope: envelope(turnIntentId),
        });
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(latestContext?.sendStatus).toMatchObject({
        phase: "completed",
        turnIntentId,
      });
      expect(
        mocks.call.mock.calls.filter(
          ([method]) => method === "session/subscribe"
        )
      ).toHaveLength(subscribeCallsBefore + 1);
    }
  );

  it("does not settle the current send from another turn's terminal event", async () => {
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "current turn");
      await Promise.resolve();
    });
    await act(async () => {
      sendResult.resolve({ execution: "managed_cli" });
      await pendingSend;
    });

    act(() => {
      mocks.notificationHandler?.("orgii/event", {
        sessionId: "session-a",
        envelope: {
          type: "code_session.status_changed",
          session_id: "session-a",
          turn_intent_id: "another-turn",
          status: "completed",
        },
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(latestContext?.sendStatus).toMatchObject({
      phase: "accepted",
      turnIntentId: mocks.sendParams?.turnIntentId,
    });
  });

  it("loads a selected historical round through session/round", async () => {
    act(() => latestContext?.selectRound("round-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.call).toHaveBeenCalledWith("session/round", {
      sessionId: "session-a",
      roundId: "round-1",
    });
    expect(latestContext).toMatchObject({
      selectedRoundId: "round-1",
      activeRoundId: "round-1",
      transcriptPhase: "ready",
    });
    expect(latestContext?.transcriptItems).toEqual([
      expect.objectContaining({ text: "History round-1" }),
    ]);
  });

  it("opens only the event-owned file target in the paired Desktop", async () => {
    await act(async () => {
      await latestContext?.openSessionFileInDesktop(
        "session-a",
        "round-2",
        "event-edit-1",
        1
      );
    });

    expect(mocks.call).toHaveBeenCalledWith("session/open_file", {
      sessionId: "session-a",
      roundId: "round-2",
      eventId: "event-edit-1",
      targetIndex: 1,
    });
  });

  it("refreshes the round index after a settled live delta", async () => {
    const subscribeCallsBefore = mocks.call.mock.calls.filter(
      ([method]) => method === "session/subscribe"
    ).length;
    act(() => {
      mocks.notificationHandler?.("orgii/snapshot", {
        sessionId: "session-a",
        version: 2,
        snapshotDelta: true,
        streaming: false,
        upserts: [
          {
            id: "settled-agent",
            source: "assistant",
            displayVariant: "message",
            displayText: "Settled",
          },
        ],
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      mocks.call.mock.calls.filter(([method]) => method === "session/subscribe")
    ).toHaveLength(subscribeCallsBefore + 1);
  });

  it("moves a send from an older round back to follow-latest", async () => {
    act(() => latestContext?.selectRound("round-1"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    let pendingSend!: Promise<void>;
    await act(async () => {
      pendingSend = latestContext!.sendMessage("session-a", "new latest turn");
      await Promise.resolve();
    });

    expect(latestContext?.selectedRoundId).toBeNull();
    expect(latestContext?.activeRoundId).toBe(
      `local-pending:${String(mocks.sendParams?.turnIntentId)}`
    );
    expect(latestContext?.transcriptRounds.map((round) => round.id)).toEqual([
      "round-1",
      "round-2",
      "round-3",
      `local-pending:${String(mocks.sendParams?.turnIntentId)}`,
    ]);
    expect(latestContext?.transcriptItems.at(-1)).toMatchObject({
      text: "new latest turn",
      optimistic: true,
    });

    await act(async () => {
      sendResult.resolve({ execution: "native_agent" });
      await pendingSend;
    });
  });
});
