// @vitest-environment jsdom
import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ActiveMessageDelivery,
  type QueuedMessage,
  activeMessageDeliveriesAtom,
  messageDeliveryRecordsAtom,
  messageQueueAtom,
  messageQueueHandoffIdsAtom,
  messageQueueHydratedAtom,
} from "@src/store/ui/messageQueueAtom";

import {
  cancelQueuedMessageDeliveries,
  flushMessageQueuePersistence,
  handoffQueuedMessageToActiveDelivery,
  hydrateMessageQueue,
  reconcileOrphanedOptimisticQueueProjections,
  refreshMessageDeliveries,
  returnActiveDeliveryToMessageQueue,
} from "../messageQueuePersistence";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  persist: vi.fn(),
  handoff: vi.fn(),
  returnToQueue: vi.fn(),
  cancelQueued: vi.fn(),
  removeOptimistic: vi.fn(),
  findOwners: vi.fn(),
  getEvents: vi.fn(),
  updateById: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("@src/store/ui/messageQueueRepository", () => ({
  loadDurableMessageDeliveries: mocks.load,
  persistDurableMessageQueue: mocks.persist,
  handoffDurableMessageDelivery: mocks.handoff,
  returnDurableMessageDeliveryToQueue: mocks.returnToQueue,
  removeDurableQueuedMessageDeliveries: mocks.cancelQueued,
  findDurableMessageDeliveryOwnerIds: mocks.findOwners,
}));

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: mocks.getEvents,
    updateById: mocks.updateById,
    subscribe: mocks.subscribe,
  },
  isStreamingSnapshot: (snapshot: { streaming?: boolean }) =>
    snapshot.streaming === true,
}));

vi.mock("@src/engines/SessionCore/services/userIntentDispatch", () => ({
  isOptimisticQueueUserEventId: (eventId: string) =>
    eventId.startsWith("queued-user:") && eventId.endsWith(":"),
  optimisticQueueUserEventId: (queueMessageId: string) =>
    `queued-user:${queueMessageId}:`,
  removeOptimisticQueueUserDelivery: mocks.removeOptimistic,
}));

function message(
  id: string,
  overrides: Partial<QueuedMessage> = {}
): QueuedMessage {
  return {
    id,
    turnIntentId: `intent-${id}`,
    sessionId: "session-1",
    content: id,
    displayContent: id,
    priority: "next",
    status: "queued",
    createdAt: `2026-07-23T00:00:0${id.length}.000Z`,
    ...overrides,
  };
}

function activeDelivery(
  id: string,
  overrides: Partial<ActiveMessageDelivery> = {}
): ActiveMessageDelivery {
  return {
    ...message(id),
    conversationDispatch: {
      kind: "canonical_conversation",
      root: {
        authority: "local-session",
        authorityScope: [],
        conversationId: "root-1",
      },
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
        workspaceRepoPath: "/repo",
      },
    },
    status: "accepted",
    runnerSessionId: `runner-${id}`,
    ...overrides,
  };
}

describe("messageQueuePersistence", () => {
  beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue({ queue: [], active: [] });
    mocks.persist.mockReset().mockResolvedValue(undefined);
    mocks.handoff.mockReset();
    mocks.returnToQueue.mockReset();
    mocks.cancelQueued.mockReset().mockResolvedValue([]);
    mocks.removeOptimistic.mockReset().mockResolvedValue(undefined);
    mocks.findOwners.mockReset().mockResolvedValue(new Set());
    mocks.getEvents.mockReset().mockResolvedValue([]);
    mocks.updateById.mockReset().mockResolvedValue(true);
    mocks.subscribe.mockReset().mockReturnValue(vi.fn());
  });

  it("parks a legacy queued row before opening the dispatch gate", async () => {
    const durable = message("durable");
    mocks.load.mockResolvedValue({ queue: [durable], active: [] });
    const store = createStore();

    expect(store.get(messageQueueHydratedAtom)).toBe(false);
    await hydrateMessageQueue(store);

    const recovered = {
      ...durable,
      priority: "next" as const,
      requiresExplicitDispatch: true,
    };
    expect(store.get(messageQueueAtom)).toEqual([recovered]);
    expect(store.get(messageQueueHydratedAtom)).toBe(true);
    expect(mocks.persist).toHaveBeenCalledWith([recovered]);
  });

  it("keeps a canonical queued row runnable after restart", async () => {
    const durable = message("canonical", {
      conversationDispatch: activeDelivery("canonical").conversationDispatch,
    });
    mocks.load.mockResolvedValue({ queue: [durable], active: [] });
    const store = createStore();

    await hydrateMessageQueue(store);

    expect(store.get(messageQueueAtom)).toEqual([durable]);
    expect(store.get(messageQueueHydratedAtom)).toBe(true);
    expect(mocks.persist).toHaveBeenCalledWith([durable]);
  });

  it("preserves a canonical Send Now priority across restart", async () => {
    const durable = message("canonical-now", {
      priority: "now",
      conversationDispatch:
        activeDelivery("canonical-now").conversationDispatch,
    });
    mocks.load.mockResolvedValue({ queue: [durable], active: [] });
    const store = createStore();

    await hydrateMessageQueue(store);

    expect(store.get(messageQueueAtom)).toEqual([durable]);
    expect(mocks.persist).toHaveBeenCalledWith([durable]);
  });

  it("preserves an explicitly held canonical row across restart", async () => {
    const durable = message("canonical-held", {
      priority: "now",
      requiresExplicitDispatch: true,
      conversationDispatch:
        activeDelivery("canonical-held").conversationDispatch,
    });
    mocks.load.mockResolvedValue({ queue: [durable], active: [] });
    const store = createStore();

    await hydrateMessageQueue(store);

    expect(store.get(messageQueueAtom)).toEqual([durable]);
    expect(mocks.persist).toHaveBeenCalledWith([durable]);
  });

  it("fails an ownerless pending projection in place after owner hydration", async () => {
    const orphan = {
      id: "queued-user:legacy-orphan:",
      sessionId: "session-orphan",
      source: "user",
      displayText: "@VantaNode inspect this",
      displayStatus: "pending",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "pending",
        queueMessageId: "legacy-orphan",
        turnIntentId: "intent-legacy-orphan",
        message: { role: "user", content: "@VantaNode inspect this" },
        images: ["data:image/png;base64,keep"],
        mentions: [{ id: "vanta", label: "VantaNode" }],
      },
    };
    mocks.getEvents.mockResolvedValue([orphan]);

    await reconcileOrphanedOptimisticQueueProjections("session-orphan");

    expect(mocks.findOwners).toHaveBeenCalledWith(["legacy-orphan"]);
    expect(mocks.removeOptimistic).not.toHaveBeenCalled();
    expect(mocks.updateById).toHaveBeenCalledWith(
      "queued-user:legacy-orphan:",
      {
        displayStatus: "failed",
        result: expect.objectContaining({
          syntheticUserInput: true,
          deliveryStatus: "failed",
          deliveryError: expect.stringContaining(
            "pending delivery could not be recovered"
          ),
          turnIntentId: "intent-legacy-orphan",
          message: { role: "user", content: "@VantaNode inspect this" },
          images: ["data:image/png;base64,keep"],
          mentions: [{ id: "vanta", label: "VantaNode" }],
        }),
      },
      "session-orphan"
    );
    const patch = mocks.updateById.mock.calls[0]?.[1] as {
      result: Record<string, unknown>;
    };
    expect(patch.result).not.toHaveProperty("queueMessageId");
  });

  it("retries reconciliation when queue hydration precedes EventStore hydration", async () => {
    const orphan = {
      id: "queued-user:late-orphan:",
      sessionId: "session-late",
      source: "user",
      displayStatus: "pending",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "pending",
        queueMessageId: "late-orphan",
      },
    };
    const store = createStore();
    await hydrateMessageQueue(store);
    expect(mocks.getEvents).not.toHaveBeenCalled();

    mocks.getEvents.mockResolvedValue([orphan]);
    const inspectSnapshot = mocks.subscribe.mock.calls.at(-1)?.[0] as (
      snapshot: { chatEvents: (typeof orphan)[]; eventCount: number },
      sessionId: string
    ) => void;
    inspectSnapshot({ chatEvents: [orphan], eventCount: 1 }, "session-late");

    await vi.waitFor(() =>
      expect(mocks.updateById).toHaveBeenCalledWith(
        "queued-user:late-orphan:",
        expect.objectContaining({ displayStatus: "failed" }),
        "session-late"
      )
    );
  });

  it("preserves pending rows with any durable owner and accepted provider rows", async () => {
    const owned = {
      id: "queued-user:owned:",
      sessionId: "session-owned",
      source: "user",
      displayStatus: "pending",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "pending",
        queueMessageId: "owned",
      },
    };
    const sent = {
      ...owned,
      id: "queued-user:sent:",
      displayStatus: "completed",
      result: {
        ...owned.result,
        deliveryStatus: "sent",
        queueMessageId: "sent",
      },
    };
    const providerOwned = {
      ...owned,
      id: "provider-user-row",
      result: { message: { role: "user", content: "keep me" } },
    };
    mocks.getEvents.mockResolvedValue([owned, sent, providerOwned]);
    mocks.findOwners.mockResolvedValue(new Set(["owned"]));

    await reconcileOrphanedOptimisticQueueProjections("session-owned");

    expect(mocks.findOwners).toHaveBeenCalledWith(["owned"]);
    expect(mocks.removeOptimistic).not.toHaveBeenCalled();
    expect(mocks.updateById).not.toHaveBeenCalled();
  });

  it("preserves a row accepted while durable ownership is being checked", async () => {
    const pending = {
      id: "queued-user:accepting:",
      sessionId: "session-accepting",
      source: "user",
      displayStatus: "pending",
      result: {
        syntheticUserInput: true,
        deliveryStatus: "pending",
        queueMessageId: "accepting",
      },
    };
    const sent = {
      ...pending,
      displayStatus: "completed",
      result: { ...pending.result, deliveryStatus: "sent" },
    };
    mocks.getEvents
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([sent]);

    await reconcileOrphanedOptimisticQueueProjections("session-accepting");

    expect(mocks.findOwners).toHaveBeenCalledWith(["accepting"]);
    expect(mocks.updateById).not.toHaveBeenCalled();
  });

  it("deduplicates by turn intent and lets live mutations win hydration races", async () => {
    const durable = message("durable", { turnIntentId: "shared-intent" });
    const live = message("live", {
      turnIntentId: "shared-intent",
      content: "edited while loading",
    });
    const store = createStore();
    store.set(messageQueueAtom, [live]);
    mocks.load.mockResolvedValue({ queue: [durable], active: [] });

    await hydrateMessageQueue(store);

    expect(store.get(messageQueueAtom)).toEqual([live]);
  });

  it("persists queue mutations after hydration", async () => {
    const store = createStore();
    await hydrateMessageQueue(store);
    mocks.persist.mockClear();

    const next = message("next");
    store.set(messageQueueAtom, [next]);

    expect(mocks.persist).toHaveBeenCalledWith([next]);
  });

  it("exposes the current durable queue write as a commit barrier", async () => {
    const store = createStore();
    await hydrateMessageQueue(store);
    let release!: () => void;
    mocks.persist.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const next = message("barrier");
    store.set(messageQueueAtom, [next]);
    let flushed = false;
    const flush = flushMessageQueuePersistence(store).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(mocks.persist).toHaveBeenCalledWith([next]);

    release();
    await flush;
    expect(flushed).toBe(true);
  });

  it("retries a transient durable read and installs persistence after recovery", async () => {
    const store = createStore();
    mocks.load
      .mockRejectedValueOnce(new Error("store starting"))
      .mockResolvedValueOnce({ queue: [], active: [] });

    await expect(hydrateMessageQueue(store)).rejects.toThrow("store starting");
    expect(store.get(messageQueueHydratedAtom)).toBe(false);

    await hydrateMessageQueue(store);
    mocks.persist.mockClear();
    const next = message("after-recovery");
    store.set(messageQueueAtom, [next]);

    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(mocks.persist).toHaveBeenCalledWith([next]);
  });

  it("does not resurrect a deletion while a durable refresh is racing it", async () => {
    const old = message("old");
    let durable: QueuedMessage[] = [old];
    let releasePersist!: () => void;
    mocks.load.mockImplementation(async () => ({ queue: durable, active: [] }));
    const store = createStore();
    await hydrateMessageQueue(store);
    mocks.persist.mockImplementation(
      (snapshot: QueuedMessage[]) =>
        new Promise<void>((resolve) => {
          releasePersist = () => {
            durable = snapshot;
            resolve();
          };
        })
    );

    store.set(messageQueueAtom, []);
    const refresh = refreshMessageDeliveries(store);
    await Promise.resolve();
    expect(store.get(messageQueueAtom)).toEqual([]);
    releasePersist();
    await refresh;

    expect(store.get(messageQueueAtom)).toEqual([]);
  });

  it("hydrates accepted recovery metadata into the same delivery registry", async () => {
    const queued = message("shared");
    const active = activeDelivery("shared", {
      runnerSessionId: "cliagent-runner",
    });
    mocks.load.mockResolvedValue({ queue: [queued], active: [active] });
    const store = createStore();

    await hydrateMessageQueue(store);

    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([active]);

    const next = message("next");
    store.set(messageQueueAtom, [next]);
    expect(store.get(messageQueueAtom)).toEqual([next]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([active]);
  });

  it("cancels the durable queued owner and its exact optimistic projection", async () => {
    const queued = message("cancel", { sessionId: "native-session" });
    const sibling = message("keep");
    const active = activeDelivery("active");
    mocks.cancelQueued.mockResolvedValue([queued]);
    const store = createStore();
    store.set(messageDeliveryRecordsAtom, [queued, sibling, active]);

    await cancelQueuedMessageDeliveries(store, [queued.id]);

    expect(mocks.cancelQueued).toHaveBeenCalledWith([
      { id: queued.id, turnIntentId: queued.turnIntentId },
    ]);
    expect(mocks.removeOptimistic).toHaveBeenCalledWith({
      sessionId: "native-session",
      queueMessageId: queued.id,
    });
    expect(store.get(messageQueueAtom)).toEqual([sibling]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([active]);
    expect(store.get(messageQueueHandoffIdsAtom)).toEqual(new Set());
  });

  it("does not cancel a queue row while its ownership handoff is frozen", async () => {
    const frozen = message("frozen");
    const cancellable = message("cancellable");
    mocks.cancelQueued.mockResolvedValue([cancellable]);
    const store = createStore();
    store.set(messageQueueAtom, [frozen, cancellable]);
    store.set(messageQueueHandoffIdsAtom, new Set([frozen.id]));

    await cancelQueuedMessageDeliveries(store, [frozen.id, cancellable.id]);

    expect(mocks.cancelQueued).toHaveBeenCalledWith([
      { id: cancellable.id, turnIntentId: cancellable.turnIntentId },
    ]);
    expect(store.get(messageQueueAtom)).toEqual([frozen]);
    expect(store.get(messageQueueHandoffIdsAtom)).toEqual(new Set([frozen.id]));
  });

  it("preserves a concurrent enqueue while cancellation is pending", async () => {
    const cancelled = message("cancelled");
    const concurrent = message("concurrent");
    let release!: () => void;
    mocks.cancelQueued.mockImplementation(
      () =>
        new Promise<QueuedMessage[]>((resolve) => {
          release = () => resolve([cancelled]);
        })
    );
    const store = createStore();
    store.set(messageQueueAtom, [cancelled]);

    const cancellation = cancelQueuedMessageDeliveries(store, [cancelled.id]);
    await vi.waitFor(() => expect(mocks.cancelQueued).toHaveBeenCalledOnce());
    store.set(messageQueueAtom, (current) => [...current, concurrent]);
    release();
    await cancellation;

    expect(store.get(messageQueueAtom)).toEqual([concurrent]);
  });

  it("restores only the owner whose optimistic projection could not be removed", async () => {
    const cancelled = message("cancelled");
    const retained = message("retained");
    mocks.cancelQueued.mockResolvedValue([cancelled, retained]);
    mocks.removeOptimistic.mockImplementation(
      async ({ queueMessageId }: { queueMessageId: string }) => {
        if (queueMessageId === retained.id) throw new Error("event store busy");
      }
    );
    const store = createStore();
    store.set(messageQueueAtom, [cancelled, retained]);

    await expect(
      cancelQueuedMessageDeliveries(store, [cancelled.id, retained.id])
    ).rejects.toThrow(
      "failed to remove 1 optimistic queued message projection"
    );

    expect(mocks.persist).toHaveBeenCalledWith([retained]);
    expect(store.get(messageQueueAtom)).toEqual([retained]);
    expect(store.get(messageQueueHandoffIdsAtom)).toEqual(new Set());
  });

  it("publishes the durable active snapshot after a queue handoff", async () => {
    const queued = message("queued", {
      conversationDispatch: activeDelivery("queued").conversationDispatch,
    });
    const delivery = activeDelivery("queued", {
      status: "preparing",
      runnerSessionId: undefined,
    });
    const peer = activeDelivery("peer");
    mocks.handoff.mockResolvedValue({
      delivery,
      queue: [],
      active: [peer, delivery],
    });
    const store = createStore();
    store.set(messageQueueAtom, [queued]);

    await handoffQueuedMessageToActiveDelivery(store, delivery);

    expect(store.get(messageQueueAtom)).toEqual([]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([peer, delivery]);
  });

  it("preserves a concurrent enqueue while queue handoff is pending", async () => {
    const queued = message("queued", {
      conversationDispatch: activeDelivery("queued").conversationDispatch,
    });
    const concurrent = message("concurrent");
    const delivery = activeDelivery("queued", {
      status: "preparing",
      runnerSessionId: undefined,
    });
    let release!: () => void;
    mocks.handoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ delivery, queue: [], active: [delivery] });
        })
    );
    const store = createStore();
    store.set(messageQueueAtom, [queued]);

    const handoff = handoffQueuedMessageToActiveDelivery(store, delivery);
    await vi.waitFor(() => expect(mocks.handoff).toHaveBeenCalledOnce());
    store.set(messageQueueAtom, (current) => [...current, concurrent]);
    release();
    await handoff;

    expect(store.get(messageQueueAtom)).toEqual([concurrent]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([delivery]);
  });

  it("publishes the durable active snapshot when an owner returns to queue", async () => {
    const returning = message("returning", {
      conversationDispatch: activeDelivery("returning").conversationDispatch,
      requiresExplicitDispatch: true,
    });
    const staleLocalPeer = activeDelivery("stale-peer");
    const durablePeer = activeDelivery("durable-peer");
    mocks.returnToQueue.mockResolvedValue({
      message: returning,
      active: [durablePeer],
    });
    const store = createStore();
    store.set(messageDeliveryRecordsAtom, [
      staleLocalPeer,
      activeDelivery("returning"),
    ]);

    await returnActiveDeliveryToMessageQueue(store, "returning", returning);

    expect(store.get(messageQueueAtom)).toEqual([returning]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([durablePeer]);
  });

  it("preserves a concurrent enqueue while an owner return is pending", async () => {
    const returning = message("returning", {
      conversationDispatch: activeDelivery("returning").conversationDispatch,
      requiresExplicitDispatch: true,
    });
    const concurrent = message("concurrent");
    let release!: () => void;
    mocks.returnToQueue.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ message: returning, active: [] });
        })
    );
    const store = createStore();
    store.set(messageDeliveryRecordsAtom, [activeDelivery("returning")]);

    const restoration = returnActiveDeliveryToMessageQueue(
      store,
      "returning",
      returning
    );
    await vi.waitFor(() => expect(mocks.returnToQueue).toHaveBeenCalledOnce());
    store.set(messageQueueAtom, [concurrent]);
    release();
    await restoration;

    expect(store.get(messageQueueAtom)).toEqual([concurrent, returning]);
    expect(store.get(activeMessageDeliveriesAtom)).toEqual([]);
  });
});
