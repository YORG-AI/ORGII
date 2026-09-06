// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { turnLifecycleSignalAtom } from "@src/engines/SessionCore/control/turnLifecycle";
import {
  QueuedConversationBlockedError,
  QueuedConversationRecoveryBlockedError,
  QueuedConversationRecoveryPendingError,
  QueuedConversationTurnFailedError,
} from "@src/engines/SessionCore/conversations/queuedConversationContract";
import { UserIntentSendError } from "@src/engines/SessionCore/services/userIntentDispatch";
import {
  type ActiveMessageDelivery,
  type QueuedMessage,
  activeMessageDeliveriesAtom,
  isActiveMessageDelivery,
  messageDeliveryRecordsAtom,
  messageQueueAtom,
  messageQueueHydratedAtom,
} from "@src/store/ui/messageQueueAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useQueueDispatch } from "../useQueueDispatch";

const SESSION_ID = "agent-builtin:sde-queued-worker";
type JotaiStore = ReturnType<typeof createStore>;

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  beginOptimisticTurn: vi.fn(),
  beginTurnDispatch: vi.fn(),
  beginTurnStopping: vi.fn(),
  cancelTurn: vi.fn(),
  canonicalUpdateFailure: false,
  clearTurnLifecycleSession: vi.fn(),
  dispatchCanonicalConversation: vi.fn(),
  confirmTurnRunning: vi.fn(),
  failOptimisticTurn: vi.fn(),
  getSession: vi.fn(),
  getPersistedEvents: vi.fn(),
  getTurnGeneration: vi.fn(),
  getTurnPhase: vi.fn(),
  markSessionActive: vi.fn(),
  markTurnTerminal: vi.fn(),
  messageError: vi.fn(),
  messageWarning: vi.fn(),
  loadDurableMessageDeliveries: vi.fn(),
  persistDurableMessageQueue: vi.fn(),
  restoreTurnWorkingAfterInterruptFailure: vi.fn(),
  sendMessage: vi.fn(),
  updateById: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  getSession: mocks.getSession,
}));

vi.mock("@src/components/Message", () => ({
  Message: {
    error: mocks.messageError,
    warning: mocks.messageWarning,
  },
}));

vi.mock("@src/engines/SessionCore/control/optimisticTurnStatus", () => ({
  beginOptimisticTurn: mocks.beginOptimisticTurn,
  failOptimisticTurn: mocks.failOptimisticTurn,
}));

vi.mock("@src/engines/SessionCore/control/sessionTimelineBoundary", () => ({
  cancelTurnForTimelineBoundary: mocks.cancelTurn,
}));

vi.mock("@src/engines/SessionCore/control/turnLifecycle", async () => {
  const { atom } = await import("jotai/vanilla");
  return {
    beginTurnDispatch: mocks.beginTurnDispatch,
    beginTurnStopping: mocks.beginTurnStopping,
    clearTurnLifecycleSession: mocks.clearTurnLifecycleSession,
    confirmTurnRunning: mocks.confirmTurnRunning,
    getTurnGeneration: mocks.getTurnGeneration,
    getTurnPhase: mocks.getTurnPhase,
    markTurnTerminal: mocks.markTurnTerminal,
    restoreTurnWorkingAfterInterruptFailure:
      mocks.restoreTurnWorkingAfterInterruptFailure,
    turnLifecycleSignalAtom: atom(0),
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: mocks.append,
    getPersistedEvents: mocks.getPersistedEvents,
    updateById: mocks.updateById,
    upsert: mocks.upsert,
  },
}));

vi.mock(
  "@src/engines/SessionCore/hooks/session/messageQueuePersistence",
  () => {
    let currentStore: JotaiStore | null = null;
    return {
      hydrateMessageQueue: async (store: JotaiStore) => {
        currentStore = store;
        const snapshot = await mocks.loadDurableMessageDeliveries();
        const activeIntents = new Set(
          snapshot.active.map(
            (delivery: ActiveMessageDelivery) => delivery.turnIntentId
          )
        );
        const queueByIntent = new Map<string, QueuedMessage>();
        for (const message of snapshot.queue as QueuedMessage[]) {
          queueByIntent.set(message.turnIntentId, message);
        }
        for (const message of store.get(messageQueueAtom)) {
          queueByIntent.set(message.turnIntentId, message);
        }
        store.set(messageDeliveryRecordsAtom, [
          ...[...queueByIntent.values()].filter(
            (message) => !activeIntents.has(message.turnIntentId)
          ),
          ...snapshot.active,
        ]);
        await mocks.persistDurableMessageQueue(store.get(messageQueueAtom));
        store.set(messageQueueHydratedAtom, true);
      },
      disposeMessageQueuePersistence: () => undefined,
      refreshMessageDeliveries: async () => undefined,
      assertDurableActiveDeliveryIsRootHead: async (id: string) => {
        const owner = currentStore
          ?.get(activeMessageDeliveriesAtom)
          .find((candidate) => candidate.id === id);
        if (!owner) throw new Error("missing active delivery owner");
        return owner;
      },
      handoffQueuedMessageToActiveDelivery: async (
        targetStore: JotaiStore,
        delivery: ActiveMessageDelivery
      ) => {
        currentStore = targetStore;
        targetStore.set(messageDeliveryRecordsAtom, (current) => [
          ...current.filter(
            (record) =>
              record.id !== delivery.id &&
              record.turnIntentId !== delivery.turnIntentId
          ),
          delivery,
        ]);
      },
      returnActiveDeliveryToMessageQueue: async (
        targetStore: JotaiStore,
        id: string,
        message: QueuedMessage
      ) => {
        targetStore.set(messageDeliveryRecordsAtom, (current) => [
          ...current.filter(
            (record) => record.id !== id && record.id !== message.id
          ),
          message,
        ]);
      },
      updateActiveMessageDelivery: async (
        targetStore: JotaiStore,
        id: string,
        update: Partial<ActiveMessageDelivery>
      ) => {
        if (mocks.canonicalUpdateFailure) {
          throw new Error("durable execution store unavailable");
        }
        let updated: ActiveMessageDelivery | null = null;
        targetStore.set(messageDeliveryRecordsAtom, (current) =>
          current.map((record) => {
            if (!isActiveMessageDelivery(record) || record.id !== id) {
              return record;
            }
            updated = { ...record, ...update };
            return updated;
          })
        );
        return updated;
      },
      removeActiveMessageDelivery: async (
        targetStore: JotaiStore,
        id: string
      ) => {
        targetStore.set(messageDeliveryRecordsAtom, (current) =>
          current.filter((record) => record.id !== id)
        );
      },
      replaceActiveMessageDeliveryLocally: (
        targetStore: JotaiStore,
        id: string,
        update: Partial<ActiveMessageDelivery>
      ) => {
        targetStore.set(messageDeliveryRecordsAtom, (current) =>
          current.map((record) =>
            isActiveMessageDelivery(record) && record.id === id
              ? { ...record, ...update }
              : record
          )
        );
      },
    };
  }
);

vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { sendMessage: mocks.sendMessage },
}));

vi.mock("@src/engines/SessionCore/sync/adapters/shared/eventFactories", () => ({
  createSyntheticUserEvent: (
    sessionId: string,
    content: string,
    options?: Record<string, unknown>
  ) => ({
    id: options?.id ?? "synthetic-user-event",
    chunk_id: null,
    sessionId,
    createdAt: "2026-07-18T00:00:00.000Z",
    functionName: "user_message",
    uiCanonical: "",
    actionType: "raw",
    source: "user",
    args: {},
    result: {
      syntheticUserInput: true,
      message: { content, role: "user" },
      ...(options ?? {}),
    },
    displayText: content,
    displayStatus:
      options?.deliveryStatus === "failed"
        ? "failed"
        : options?.deliveryStatus === "pending"
          ? "pending"
          : "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  }),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock("@src/store/session", () => ({
  markSessionActive: mocks.markSessionActive,
}));

vi.mock("@src/store/ui/messageQueueRepository", () => ({
  getMessageQueueOwnerKey: async () => "queue:main",
  isPrimaryMessageQueueOwnerKey: (key: string) => key === "queue:main",
  persistDurableMessageQueue: mocks.persistDurableMessageQueue,
  withCanonicalConversationTurnLock: async (
    _root: unknown,
    run: () => Promise<unknown>
  ) => await run(),
}));

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn(),
}));

vi.mock("@src/util/session/resolveModelForMessage", () => ({
  resolveModelForMessage: () => ({
    model: "test-model",
    accountId: "test-account",
  }),
}));

vi.mock("@src/util/session/selectionFromSession", () => ({
  selectionFromSession: () => null,
}));

vi.mock("@src/util/session/sessionDispatch", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@src/util/session/sessionDispatch")
  >()),
  isAgentSession: () => false,
  isCliSession: () => false,
  isCursorIdeSession: () => false,
}));

function makeQueuedMessage(): QueuedMessage {
  return {
    id: "queued-intervention-1",
    turnIntentId: "turn-intent-queued-1",
    sessionId: SESSION_ID,
    content: "queued worker follow-up",
    displayContent: "queued worker follow-up",
    modelSelection: { model: "test-model" },
    agentExecMode: "build",
    priority: "now",
    status: "queued",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

function makeCanonicalMessage(
  id: string,
  conversationId = "root-1"
): QueuedMessage {
  return {
    ...makeQueuedMessage(),
    id,
    turnIntentId: `turn-intent-${id}`,
    priority: "next",
    conversationDispatch: {
      kind: "canonical_conversation",
      root: {
        authority: "local-session",
        authorityScope: [],
        conversationId,
      },
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
        workspaceRepoPath: "/repo",
      },
    },
  };
}

function installLifecycleSimulation(): void {
  const phases = new Map<string, string>();
  const generations = new Map<string, number>();
  mocks.beginTurnDispatch.mockImplementation((scopeKey: string) => {
    const generation = (generations.get(scopeKey) ?? 0) + 1;
    generations.set(scopeKey, generation);
    phases.set(scopeKey, "dispatching");
    return generation;
  });
  mocks.beginTurnStopping.mockImplementation((scopeKey: string) => {
    phases.set(scopeKey, "stopping");
  });
  mocks.clearTurnLifecycleSession.mockImplementation((scopeKey: string) => {
    phases.delete(scopeKey);
    generations.delete(scopeKey);
  });
  mocks.confirmTurnRunning.mockImplementation((scopeKey: string) => {
    phases.set(scopeKey, "working");
  });
  mocks.getTurnGeneration.mockImplementation(
    (scopeKey: string) => generations.get(scopeKey) ?? 0
  );
  mocks.getTurnPhase.mockImplementation(
    (scopeKey: string) => phases.get(scopeKey) ?? "idle"
  );
  mocks.markTurnTerminal.mockImplementation((scopeKey: string) => {
    phases.set(scopeKey, "idle");
  });
  mocks.restoreTurnWorkingAfterInterruptFailure.mockImplementation(
    (scopeKey: string) => {
      if (phases.get(scopeKey) === "stopping") {
        phases.set(scopeKey, "working");
      }
    }
  );
}

function QueueDispatchHarness(): null {
  useQueueDispatch(mocks.dispatchCanonicalConversation);
  return null;
}

describe("useQueueDispatch Agent Org intervention", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    mocks.canonicalUpdateFailure = false;
    mocks.append.mockReset().mockResolvedValue(undefined);
    mocks.beginOptimisticTurn.mockReset();
    mocks.beginTurnDispatch.mockReset().mockReturnValue(11);
    mocks.beginTurnStopping.mockReset();
    mocks.cancelTurn.mockReset().mockResolvedValue(undefined);
    mocks.clearTurnLifecycleSession.mockReset();
    mocks.dispatchCanonicalConversation
      .mockReset()
      .mockImplementation(async (_store, message, callbacks) => {
        await callbacks.onAccepted(message.sessionId);
        return { terminalStatus: "completed" };
      });
    mocks.confirmTurnRunning.mockReset();
    mocks.failOptimisticTurn.mockReset();
    mocks.getSession.mockReset().mockResolvedValue(null);
    mocks.getPersistedEvents.mockReset().mockResolvedValue([]);
    mocks.getTurnGeneration.mockReset().mockReturnValue(11);
    mocks.getTurnPhase.mockReset().mockReturnValue("idle");
    mocks.markSessionActive.mockReset();
    mocks.markTurnTerminal.mockReset();
    mocks.messageError.mockReset();
    mocks.messageWarning.mockReset();
    mocks.loadDurableMessageDeliveries
      .mockReset()
      .mockResolvedValue({ queue: [], active: [] });
    mocks.persistDurableMessageQueue.mockReset().mockResolvedValue(undefined);
    mocks.restoreTurnWorkingAfterInterruptFailure.mockReset();
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    mocks.updateById.mockReset().mockResolvedValue(true);
    mocks.upsert.mockReset().mockResolvedValue(undefined);
    store = createStore();
    store.set(messageDeliveryRecordsAtom, []);
    root = createSmokeRoot();
  });

  afterEach(async () => {
    await root.unmount();
  });

  async function mountWithMessages(messages: QueuedMessage[]): Promise<void> {
    store.set(messageQueueAtom, messages);
    await root.render(
      createElement(Provider, { store }, createElement(QueueDispatchHarness))
    );
  }

  async function mountWithQueuedMessage(): Promise<void> {
    await mountWithMessages([makeQueuedMessage()]);
  }

  it("persists the queued event and dispatches it as direct user intent", async () => {
    await mountWithQueuedMessage();

    await vi.waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledOnce());

    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        content: "queued worker follow-up",
        turnIntentId: "turn-intent-queued-1",
        turnIntentSource: "force_send",
        directUserIntent: true,
      })
    );
    expect(mocks.append.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendMessage.mock.invocationCallOrder[0]
    );
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
  });

  it("keeps ordinary queue delivery closed when durable recovery is unavailable", async () => {
    const timeout = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(() => 1 as never);
    mocks.loadDurableMessageDeliveries.mockRejectedValueOnce(
      new Error("delivery store unavailable")
    );

    await mountWithQueuedMessage();

    await vi.waitFor(() =>
      expect(mocks.loadDurableMessageDeliveries).toHaveBeenCalled()
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(store.get(messageQueueAtom)).toEqual([makeQueuedMessage()]);
    timeout.mockRestore();
  });

  it("keeps queued delivery closed when the durable snapshot cannot be read", async () => {
    const timeout = vi
      .spyOn(window, "setTimeout")
      .mockImplementation(() => 1 as never);
    mocks.loadDurableMessageDeliveries.mockRejectedValue(
      new Error("delivery store unavailable")
    );

    await mountWithQueuedMessage();
    await vi.waitFor(() =>
      expect(mocks.loadDurableMessageDeliveries).toHaveBeenCalled()
    );

    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(store.get(messageQueueAtom)).toEqual([makeQueuedMessage()]);
    timeout.mockRestore();
  });

  it("retries canonical hydration after a transient startup failure", async () => {
    let retry: (() => void) | undefined;
    const timeout = vi
      .spyOn(window, "setTimeout")
      .mockImplementation((handler: TimerHandler) => {
        retry = handler as () => void;
        return 1 as never;
      });
    mocks.loadDurableMessageDeliveries
      .mockRejectedValueOnce(new Error("store warming up"))
      .mockResolvedValueOnce({ queue: [], active: [] });

    await mountWithMessages([makeCanonicalMessage("canonical-cold-store")]);
    await vi.waitFor(() => expect(retry).toBeTypeOf("function"));
    expect(mocks.dispatchCanonicalConversation).not.toHaveBeenCalled();

    retry?.();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce()
    );
    timeout.mockRestore();
  });

  it("does not let a blocked Send Now freeze another idle session", async () => {
    const blocked = makeQueuedMessage();
    const ready: QueuedMessage = {
      ...makeQueuedMessage(),
      id: "queued-other-session",
      turnIntentId: "turn-intent-other-session",
      sessionId: "agent-builtin:sde-other-session",
      content: "independent follow-up",
      displayContent: "independent follow-up",
      priority: "next",
    };
    mocks.getTurnPhase.mockImplementation((sessionId: string) =>
      sessionId === SESSION_ID ? "working" : "idle"
    );

    await mountWithMessages([blocked, ready]);

    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: ready.sessionId })
      )
    );
    expect(mocks.cancelTurn).toHaveBeenCalledWith(
      SESSION_ID,
      "force-send",
      expect.objectContaining({ onError: expect.any(Function) })
    );
    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({ id: blocked.id }),
      ])
    );
  });

  it("transfers a send-stage failure from the queue card to one failed bubble", async () => {
    mocks.sendMessage.mockRejectedValue(new Error("backend send unavailable"));

    await mountWithQueuedMessage();

    await vi.waitFor(() =>
      expect(mocks.updateById).toHaveBeenCalledWith(
        "synthetic-user-event",
        expect.objectContaining({
          displayStatus: "failed",
          result: expect.objectContaining({
            deliveryStatus: "failed",
            deliveryError: "backend send unavailable",
          }),
        }),
        SESSION_ID
      )
    );

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: "queued-intervention-1",
          requiresExplicitDispatch: true,
          deliveryError: "backend send unavailable",
        }),
      ])
    );
  });

  it("retains the queue card when the optimistic row could not be stored", async () => {
    mocks.append.mockRejectedValue(new Error("event store unavailable"));

    await mountWithQueuedMessage();

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: "queued-intervention-1",
          requiresExplicitDispatch: true,
        }),
      ])
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("reconciles a canonical optimistic row in place after provider acceptance", async () => {
    installLifecycleSimulation();
    const canonical = makeCanonicalMessage("canonical-user-event");

    await mountWithMessages([canonical]);
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce()
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
    expect(mocks.updateById).toHaveBeenCalledWith(
      "queued-user:canonical-user-event:",
      expect.objectContaining({
        displayStatus: "completed",
        result: expect.objectContaining({
          deliveryStatus: "sent",
          queueMessageId: "canonical-user-event",
          turnIntentId: "turn-intent-canonical-user-event",
        }),
      }),
      SESSION_ID
    );
  });

  it("waits for the concrete source turn before handing off a canonical row", async () => {
    let sourcePhase = "working";
    mocks.getTurnPhase.mockImplementation((sessionId: string) =>
      sessionId === SESSION_ID ? sourcePhase : "idle"
    );
    const canonical = makeCanonicalMessage("canonical-behind-source-turn");

    await mountWithMessages([canonical]);
    await vi.waitFor(() =>
      expect(mocks.persistDurableMessageQueue).toHaveBeenCalled()
    );
    expect(mocks.dispatchCanonicalConversation).not.toHaveBeenCalled();
    expect(store.get(messageQueueAtom)).toEqual([canonical]);

    sourcePhase = "idle";
    store.set(turnLifecycleSignalAtom, (value) => value + 1);

    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce()
    );
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
  });

  it("interrupts the concrete source for canonical Send Now before handoff", async () => {
    mocks.getTurnPhase.mockImplementation((sessionId: string) =>
      sessionId === SESSION_ID ? "working" : "idle"
    );
    const canonical = {
      ...makeCanonicalMessage("canonical-source-send-now"),
      priority: "now" as const,
    };

    await mountWithMessages([canonical]);

    await vi.waitFor(() =>
      expect(mocks.cancelTurn).toHaveBeenCalledWith(
        SESSION_ID,
        "force-send",
        expect.objectContaining({ onError: expect.any(Function) })
      )
    );
    expect(mocks.dispatchCanonicalConversation).not.toHaveBeenCalled();
  });

  it("does not bypass a held natural FIFO head in the same scope", async () => {
    const held = {
      ...makeQueuedMessage(),
      id: "held-head",
      turnIntentId: "intent-held-head",
      priority: "next" as const,
      requiresExplicitDispatch: true,
    };
    const blockedSibling = {
      ...makeQueuedMessage(),
      id: "blocked-sibling",
      turnIntentId: "intent-blocked-sibling",
      priority: "next" as const,
    };
    const independent = {
      ...makeQueuedMessage(),
      id: "independent-head",
      turnIntentId: "intent-independent-head",
      sessionId: "agent-builtin:sde-independent",
      priority: "next" as const,
    };

    await mountWithMessages([held, blockedSibling, independent]);

    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: independent.sessionId })
      )
    );
    expect(mocks.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ turnIntentId: blockedSibling.turnIntentId })
    );
    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([held, blockedSibling])
    );
  });

  it("lets a later natural message bypass a failed retry row in the same scope", async () => {
    const failed = {
      ...makeCanonicalMessage("failed-head"),
      requiresExplicitDispatch: true,
      deliveryError: "provider unavailable",
    };
    const next = {
      ...makeCanonicalMessage("natural-after-failure"),
      content: "continue after the failed turn",
      displayContent: "continue after the failed turn",
    };

    await mountWithMessages([failed, next]);

    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce()
    );
    expect(
      mocks.dispatchCanonicalConversation.mock.calls[0]?.[1]
    ).toMatchObject({ id: next.id, turnIntentId: next.turnIntentId });
    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([failed])
    );
  });

  it("recovers an accepted canonical execution before deleting its pending queue twin", async () => {
    installLifecycleSimulation();
    let finishPersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    let finishRecovery!: () => void;
    const recoveryTerminal = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const queuedTwin = makeCanonicalMessage("canonical-cold-start");
    const recovered: ActiveMessageDelivery = {
      ...queuedTwin,
      conversationDispatch: queuedTwin.conversationDispatch!,
      status: "accepted",
      runnerSessionId: "runner-cold-start",
    };
    mocks.loadDurableMessageDeliveries.mockResolvedValueOnce({
      queue: [queuedTwin],
      active: [recovered],
    });
    mocks.persistDurableMessageQueue.mockReturnValue(persistenceGate);
    mocks.dispatchCanonicalConversation.mockImplementationOnce(async () => {
      await recoveryTerminal;
      return { terminalStatus: "completed" };
    });

    await mountWithMessages([]);

    await vi.waitFor(() =>
      expect(mocks.persistDurableMessageQueue).toHaveBeenCalledWith([])
    );
    expect(mocks.dispatchCanonicalConversation).not.toHaveBeenCalled();
    finishPersistence();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce()
    );
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
    expect(
      mocks.dispatchCanonicalConversation.mock.calls[0]?.[1]
    ).toMatchObject({
      id: queuedTwin.id,
      status: "accepted",
      runnerSessionId: "runner-cold-start",
    });
    finishRecovery();
  });

  it("does not manufacture a virtual-root Session terminal", async () => {
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(message.sessionId);
        return { terminalStatus: "cancelled" };
      }
    );

    await mountWithMessages([makeCanonicalMessage("canonical-cancelled")]);

    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([])
    );
    expect(mocks.markTurnTerminal).not.toHaveBeenCalled();
  });

  it("transfers a prepared canonical failure from the queue card to its failed bubble", async () => {
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new UserIntentSendError("native launch failed", "native-user-event")
    );

    await mountWithMessages([makeCanonicalMessage("canonical-failed")]);

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: "canonical-failed",
          requiresExplicitDispatch: true,
          deliveryError: "native launch failed",
        }),
      ])
    );
    expect(mocks.updateById).toHaveBeenCalledWith(
      "queued-user:canonical-failed:",
      expect.objectContaining({
        displayStatus: "failed",
        result: expect.objectContaining({
          deliveryStatus: "failed",
          deliveryError: "native launch failed",
        }),
      }),
      SESSION_ID
    );
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it("holds an accepted turn that the provider failed outright as a failed row", async () => {
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(`runner-${message.id}`);
        throw new QueuedConversationTurnFailedError(
          "The requested model is not available"
        );
      }
    );

    await mountWithMessages([makeCanonicalMessage("canonical-rejected")]);

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: "canonical-rejected",
          requiresExplicitDispatch: true,
          deliveryError: "The requested model is not available",
        }),
      ])
    );
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([]);
    expect(mocks.updateById).toHaveBeenCalledWith(
      "queued-user:canonical-rejected:",
      expect.objectContaining({
        displayStatus: "failed",
        result: expect.objectContaining({
          deliveryStatus: "failed",
          deliveryError: "The requested model is not available",
        }),
      }),
      SESSION_ID
    );
    expect(mocks.messageError).toHaveBeenCalledOnce();
  });

  it("retains an accepted canonical owner for recovery without immediately resending", async () => {
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(`runner-${message.id}`);
        throw new UserIntentSendError(
          "native send failed",
          "native-user-event"
        );
      }
    );

    await mountWithMessages([
      makeCanonicalMessage("canonical-accepted-failed"),
    ]);

    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([
        expect.objectContaining({
          id: "canonical-accepted-failed",
          status: "accepted",
          runnerSessionId: "runner-canonical-accepted-failed",
          retryAttempt: 1,
          retryAt: expect.any(String),
        }),
      ])
    );
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
    expect(mocks.getPersistedEvents).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it("keeps an admission-blocked execution as the same failed transcript row", async () => {
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new QueuedConversationBlockedError("switch Cloud account")
    );

    await mountWithMessages([makeCanonicalMessage("canonical-blocked")]);
    await vi.waitFor(() =>
      expect(mocks.updateById).toHaveBeenCalledWith(
        "queued-user:canonical-blocked:",
        expect.objectContaining({
          displayStatus: "failed",
          result: expect.objectContaining({
            deliveryStatus: "failed",
            deliveryError: "switch Cloud account",
          }),
        }),
        SESSION_ID
      )
    );
    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({
        id: "canonical-blocked",
        requiresExplicitDispatch: true,
        deliveryError: "switch Cloud account",
      }),
    ]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([]);
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
  });

  it("keeps a pre-acceptance recovery failure as the same retryable transcript row", async () => {
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new QueuedConversationRecoveryBlockedError(
        "turn intent became stale before provider execution"
      )
    );

    await mountWithMessages([makeCanonicalMessage("canonical-stale-recovery")]);

    await vi.waitFor(() =>
      expect(mocks.updateById).toHaveBeenCalledWith(
        "queued-user:canonical-stale-recovery:",
        expect.objectContaining({
          displayStatus: "failed",
          result: expect.objectContaining({
            deliveryStatus: "failed",
            deliveryError: "turn intent became stale before provider execution",
          }),
        }),
        SESSION_ID
      )
    );
    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({
        id: "canonical-stale-recovery",
        requiresExplicitDispatch: true,
        deliveryError: "turn intent became stale before provider execution",
      }),
    ]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([]);
  });

  it("retires an accepted recovery mismatch without creating a fresh provider turn", async () => {
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(`runner-${message.id}`);
        throw new QueuedConversationRecoveryBlockedError(
          "accepted runner diverged from canonical transcript"
        );
      }
    );

    await mountWithMessages([
      makeCanonicalMessage("canonical-accepted-mismatch"),
    ]);

    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([])
    );
    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
    expect(mocks.updateById).toHaveBeenCalledWith(
      "queued-user:canonical-accepted-mismatch:",
      expect.objectContaining({
        displayStatus: "completed",
        result: expect.objectContaining({ deliveryStatus: "sent" }),
      }),
      SESSION_ID
    );
  });

  it("restores a reconciled-away failed row before retiring its accepted owner", async () => {
    mocks.updateById.mockImplementation(async (_id, patch) =>
      patch.result?.deliveryOwnerRetired ? false : true
    );
    let finishProjection!: () => void;
    mocks.upsert.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishProjection = resolve;
        })
    );
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(`runner-${message.id}`);
        throw new QueuedConversationRecoveryBlockedError("terminal verdict");
      }
    );
    const message = makeCanonicalMessage("canonical-retirement-upsert");
    await mountWithMessages([message]);
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledOnce());
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([
      expect.objectContaining({ id: message.id, status: "accepted" }),
    ]);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `queued-user:${message.id}:`,
        result: expect.objectContaining({
          turnIntentId: message.turnIntentId,
          deliveryStatus: "failed",
          deliveryOwnerRetired: true,
        }),
      }),
      SESSION_ID
    );
    finishProjection();
    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([])
    );
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
    expect(store.get(messageQueueAtom)).toEqual([]);
  });

  it.each(["missing row", "persistence rejection"])(
    "retains accepted ownership until retirement is projected after %s",
    async (failure) => {
      let projectionAvailable = false;
      mocks.upsert.mockImplementation(async () => {
        if (!projectionAvailable)
          throw new Error("projection repair unavailable");
      });
      mocks.updateById.mockImplementation(async (_id, patch) => {
        if (patch.result?.deliveryOwnerRetired && !projectionAvailable) {
          if (failure === "persistence rejection") {
            throw new Error("EventStore unavailable");
          }
          return false;
        }
        return true;
      });
      mocks.dispatchCanonicalConversation.mockImplementation(
        async (_store, message, callbacks) => {
          if (message.status !== "accepted") {
            await callbacks.onAccepted(`runner-${message.id}`);
          }
          throw new QueuedConversationRecoveryBlockedError(
            "accepted runner diverged from canonical transcript"
          );
        }
      );
      const message = {
        ...makeCanonicalMessage("canonical-retirement-recovery"),
        displayContent: "@VantaNode keep this message",
        imageDataUrls: ["data:image/png;base64,preserved"],
      };
      await mountWithMessages([message]);

      await vi.waitFor(() =>
        expect(store.get(activeMessageDeliveriesAtom)).toEqual([
          expect.objectContaining({
            id: message.id,
            turnIntentId: message.turnIntentId,
            status: "accepted",
            retryAttempt: 1,
            displayContent: message.displayContent,
            imageDataUrls: message.imageDataUrls,
          }),
        ])
      );
      expect(store.get(messageQueueAtom)).toEqual([]);
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();

      // The same existing recovery owner wakes after projection is available;
      // it must not mint or resend a different provider intent.
      projectionAvailable = true;
      store.set(messageDeliveryRecordsAtom, (records) =>
        records.map((record) => ({ ...record, retryAt: undefined }))
      );
      store.set(turnLifecycleSignalAtom, (value) => value + 1);
      await vi.waitFor(() =>
        expect(store.get(activeMessageDeliveriesAtom)).toEqual([])
      );
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2);
      expect(mocks.dispatchCanonicalConversation.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          id: message.id,
          turnIntentId: message.turnIntentId,
          status: "accepted",
        })
      );
      expect(mocks.updateById).toHaveBeenLastCalledWith(
        `queued-user:${message.id}:`,
        expect.objectContaining({
          displayText: message.displayContent,
          result: expect.objectContaining({
            deliveryStatus: "failed",
            deliveryOwnerRetired: true,
          }),
        }),
        SESSION_ID
      );
    }
  );

  it("never returns an accepted execution when a late identity check blocks", async () => {
    mocks.dispatchCanonicalConversation.mockImplementationOnce(
      async (_store, message, callbacks) => {
        await callbacks.onAccepted(`runner-${message.id}`);
        throw new QueuedConversationBlockedError("account changed late");
      }
    );

    await mountWithMessages([makeCanonicalMessage("canonical-late-blocked")]);
    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([
        expect.objectContaining({
          id: "canonical-late-blocked",
          status: "accepted",
          retryAttempt: 1,
        }),
      ])
    );
    expect(store.get(messageQueueAtom)).toEqual([]);
  });

  it("retains a canonical queue card when no optimistic row was stored", async () => {
    mocks.updateById.mockResolvedValueOnce(false);
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new Error("native preparation failed")
    );
    const message = makeCanonicalMessage("canonical-unprepared");

    await mountWithMessages([message]);

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: message.id,
          requiresExplicitDispatch: true,
        }),
      ])
    );
  });

  it("retains a canonical queue card when the failed projection cannot be persisted", async () => {
    mocks.updateById.mockRejectedValueOnce(
      new Error("failed delivery persistence unavailable")
    );
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new UserIntentSendError("native launch failed", "native-user-event")
    );
    const message = makeCanonicalMessage("canonical-failed-persistence");

    await mountWithMessages([message]);

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: message.id,
          requiresExplicitDispatch: true,
          deliveryError: "native launch failed",
        }),
      ])
    );
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([]);
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();

    store.set(turnLifecycleSignalAtom, (value) => value + 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
  });

  it("retains a preparing execution when canonical result publication is pending", async () => {
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new QueuedConversationRecoveryPendingError("cloud offline")
    );
    const message = makeCanonicalMessage("canonical-result-pending");

    await mountWithMessages([message]);

    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([
        expect.objectContaining({
          id: message.id,
          status: "preparing",
          retryAttempt: 1,
        }),
      ])
    );
    expect(store.get(messageQueueAtom)).toEqual([]);
  });

  it("backs off locally when recovery metadata cannot be persisted", async () => {
    mocks.dispatchCanonicalConversation.mockRejectedValueOnce(
      new QueuedConversationRecoveryPendingError("cloud offline")
    );
    mocks.canonicalUpdateFailure = true;
    const message = makeCanonicalMessage("canonical-store-offline");

    await mountWithMessages([message]);

    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([
        expect.objectContaining({
          id: message.id,
          retryAt: expect.any(String),
        }),
      ])
    );
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledOnce();
  });

  it("serializes two canonical turns for one root through the execution owner", async () => {
    installLifecycleSimulation();
    let releaseFirst!: () => void;
    const firstTerminal = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.dispatchCanonicalConversation.mockImplementation(
      async (_store, message, callbacks) => {
        const runnerId = `runner-${message.id}`;
        await callbacks.onRunnerReady?.(runnerId, 0);
        await callbacks.onAccepted(runnerId);
        if (message.id === "canonical-first") await firstTerminal;
        return { terminalStatus: "completed" };
      }
    );

    await mountWithMessages([
      makeCanonicalMessage("canonical-first"),
      makeCanonicalMessage("canonical-second"),
    ]);

    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1)
    );
    expect(mocks.dispatchCanonicalConversation.mock.calls[0]?.[1].id).toBe(
      "canonical-first"
    );
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([
      expect.objectContaining({
        id: "canonical-first",
        status: "accepted",
        runnerSessionId: "runner-canonical-first",
      }),
    ]);
    expect(store.get(messageQueueAtom)).toEqual([
      expect.objectContaining({ id: "canonical-second", status: "queued" }),
    ]);

    releaseFirst();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2)
    );
    expect(mocks.dispatchCanonicalConversation.mock.calls[1]?.[1].id).toBe(
      "canonical-second"
    );
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
  });

  it("drains a canonical follow-up enqueued while the first turn is active", async () => {
    installLifecycleSimulation();
    let releaseFirst!: () => void;
    const firstTerminal = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.dispatchCanonicalConversation.mockImplementation(
      async (_store, message, callbacks) => {
        const runnerId = `runner-${message.id}`;
        await callbacks.onRunnerReady?.(runnerId, 0);
        await callbacks.onAccepted(runnerId);
        if (message.id === "canonical-active") await firstTerminal;
        return { terminalStatus: "completed" };
      }
    );

    await mountWithMessages([makeCanonicalMessage("canonical-active")]);
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1)
    );

    const followUp = makeCanonicalMessage("canonical-during-active");
    store.set(messageQueueAtom, (current) => [...current, followUp]);
    expect(store.get(messageQueueAtom)).toContainEqual(followUp);
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2)
    );
    expect(mocks.dispatchCanonicalConversation.mock.calls[1]?.[1].id).toBe(
      "canonical-during-active"
    );
    await vi.waitFor(() => expect(store.get(messageQueueAtom)).toEqual([]));
  });

  it("runs independent canonical roots concurrently", async () => {
    installLifecycleSimulation();
    let acceptFirst!: () => void;
    const firstAcceptance = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    mocks.dispatchCanonicalConversation.mockImplementation(
      async (_store, message, callbacks) => {
        const runnerId = `runner-${message.id}`;
        await callbacks.onRunnerReady?.(runnerId, 0);
        if (message.id === "root-a") await firstAcceptance;
        await callbacks.onAccepted(runnerId);
        return { terminalStatus: "completed" };
      }
    );

    await mountWithMessages([
      makeCanonicalMessage("root-a", "conversation-a"),
      makeCanonicalMessage("root-b", "conversation-b"),
    ]);

    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2)
    );
    expect(store.get(messageQueueAtom)).toEqual([]);
    acceptFirst();
    await vi.waitFor(() =>
      expect(store.get(activeMessageDeliveriesAtom)).toEqual([])
    );
  });

  it("routes canonical Send Now through the active native runner", async () => {
    installLifecycleSimulation();
    let releaseFirst!: () => void;
    const firstTerminal = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.dispatchCanonicalConversation.mockImplementation(
      async (_store, message, callbacks) => {
        const runnerId = `runner-${message.id}`;
        mocks.beginTurnDispatch(runnerId);
        mocks.confirmTurnRunning(runnerId);
        await callbacks.onRunnerReady?.(runnerId, 0);
        await callbacks.onAccepted(runnerId);
        if (message.id === "canonical-running") await firstTerminal;
        mocks.markTurnTerminal(runnerId);
        return { terminalStatus: "completed" };
      }
    );
    const forceSend = {
      ...makeCanonicalMessage("canonical-force-send"),
      priority: "now" as const,
    };

    await mountWithMessages([makeCanonicalMessage("canonical-running")]);
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1)
    );
    store.set(messageQueueAtom, (current) => [...current, forceSend]);

    await vi.waitFor(() =>
      expect(mocks.cancelTurn).toHaveBeenCalledWith(
        "runner-canonical-running",
        "force-send",
        expect.objectContaining({ onError: expect.any(Function) })
      )
    );
    expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1);
    releaseFirst();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2)
    );
  });

  it("keeps a terminal canonical execution as a barrier without cancelling it", async () => {
    installLifecycleSimulation();
    let releaseFirst!: () => void;
    const firstSettlement = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    mocks.dispatchCanonicalConversation.mockImplementation(
      async (_store, message, callbacks) => {
        const runnerId = `runner-${message.id}`;
        await callbacks.onRunnerReady?.(runnerId, 0);
        await callbacks.onAccepted(runnerId);
        if (message.id === "canonical-terminal-owner") {
          await firstSettlement;
        }
        return { terminalStatus: "completed" };
      }
    );
    const forceSend = {
      ...makeCanonicalMessage("canonical-after-terminal-owner"),
      priority: "now" as const,
    };

    await mountWithMessages([makeCanonicalMessage("canonical-terminal-owner")]);
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(1)
    );
    store.set(messageQueueAtom, (current) => [...current, forceSend]);

    await vi.waitFor(() =>
      expect(mocks.getTurnPhase).toHaveBeenCalledWith(
        "runner-canonical-terminal-owner"
      )
    );
    expect(mocks.cancelTurn).not.toHaveBeenCalled();
    expect(store.get(messageQueueAtom)).toContainEqual(forceSend);

    releaseFirst();
    await vi.waitFor(() =>
      expect(mocks.dispatchCanonicalConversation).toHaveBeenCalledTimes(2)
    );
  });

  it("holds Send Now visibly when the interrupt transport rejects", async () => {
    mocks.getTurnPhase.mockImplementation((sessionId: string) =>
      sessionId === SESSION_ID ? "working" : "idle"
    );
    mocks.getTurnGeneration.mockReturnValue(7);
    mocks.cancelTurn.mockImplementation(
      async (_sessionId, _reason, options) => {
        options?.onError?.("interrupt transport unavailable");
      }
    );

    await mountWithQueuedMessage();

    await vi.waitFor(() =>
      expect(store.get(messageQueueAtom)).toEqual([
        expect.objectContaining({
          id: "queued-intervention-1",
          priority: "next",
          requiresExplicitDispatch: true,
        }),
      ])
    );
    expect(mocks.restoreTurnWorkingAfterInterruptFailure).toHaveBeenCalledWith(
      SESSION_ID,
      { generation: 7 }
    );
    expect(mocks.messageError).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("interrupt transport unavailable"),
      })
    );
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
