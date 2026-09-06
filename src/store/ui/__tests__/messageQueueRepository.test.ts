import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActiveMessageDelivery, QueuedMessage } from "../messageQueueAtom";
import {
  assertDurableActiveDeliveryIsRootHead,
  findDurableMessageDeliveryOwnerIds,
  handoffDurableMessageDelivery,
  loadDurableMessageDeliveries,
  loadDurableMessageQueue,
  persistDurableMessageQueue,
  removeDurableActiveMessageDelivery,
  removeDurableQueuedMessageDeliveries,
  resetMessageQueueRepositoryForTests,
  returnDurableMessageDeliveryToQueue,
  updateDurableActiveMessageDelivery,
} from "../messageQueueRepository";

const mocks = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  delete: vi.fn(),
  keys: vi.fn(),
  reload: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: async () => ({
    reload: mocks.reload,
    get: async (key: string) => mocks.values.get(key),
    set: async (key: string, value: unknown) => mocks.values.set(key, value),
    delete: mocks.delete,
    keys: mocks.keys,
    save: mocks.save,
  }),
}));

function message(id: string): QueuedMessage {
  return {
    id,
    turnIntentId: `turn-${id}`,
    sessionId: "session-1",
    content: id,
    displayContent: id,
    priority: "next",
    status: "queued",
    createdAt: "2026-09-02T00:00:00.000Z",
  };
}

function canonicalMessage(id: string): QueuedMessage {
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
  };
}

function activeDelivery(
  id: string,
  overrides: Partial<ActiveMessageDelivery> = {}
): ActiveMessageDelivery {
  const queued = canonicalMessage(id);
  return {
    ...queued,
    conversationDispatch: queued.conversationDispatch!,
    status: "accepted",
    runnerSessionId: `runner-${id}`,
    originQueueKey: "queue:main",
    ...overrides,
  };
}

function durableMessage(
  id: string
): QueuedMessage & { originQueueKey: string } {
  return { ...message(id), originQueueKey: "queue:main" };
}

function durableCanonicalMessage(
  id: string
): QueuedMessage & { originQueueKey: string } {
  return { ...canonicalMessage(id), originQueueKey: "queue:main" };
}

describe("message queue repository", () => {
  beforeEach(() => {
    mocks.values.clear();
    mocks.delete
      .mockReset()
      .mockImplementation(async (key: string) => mocks.values.delete(key));
    mocks.keys
      .mockReset()
      .mockImplementation(async () => [...mocks.values.keys()]);
    mocks.reload.mockReset();
    mocks.save.mockReset();
    resetMessageQueueRepositoryForTests();
  });

  it("initializes a missing first-run store before reading deliveries", async () => {
    mocks.reload.mockRejectedValueOnce(
      new Error("No such file or directory (os error 2)")
    );

    await expect(loadDurableMessageDeliveries()).resolves.toEqual({
      queue: [],
      active: [],
    });

    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a store when reload fails for another reason", async () => {
    mocks.reload.mockRejectedValueOnce(new Error("permission denied"));

    await expect(loadDurableMessageDeliveries()).rejects.toThrow(
      "permission denied"
    );

    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("migrates every legacy window queue into the unified registry", async () => {
    mocks.values.set("queue:main", [message("main")]);
    mocks.values.set("queue:aux", [message("aux")]);

    const snapshot = await loadDurableMessageDeliveries();

    expect(snapshot.queue).toEqual([message("main")]);
    expect(mocks.values.get("deliveries")).toEqual([
      { ...message("aux"), originQueueKey: "queue:aux" },
      durableMessage("main"),
    ]);
    expect(mocks.values.has("queue:main")).toBe(false);
    expect(mocks.values.has("queue:aux")).toBe(false);
  });

  it("runs legacy migration only once after cleanup", async () => {
    mocks.values.set("queue:main", [message("first")]);

    await loadDurableMessageDeliveries();
    const firstRegistry = mocks.values.get("deliveries");
    await loadDurableMessageDeliveries();

    expect(mocks.values.get("deliveries")).toEqual(firstRegistry);
    expect(mocks.values.get("deliveries")).toEqual([durableMessage("first")]);
    expect(mocks.save).toHaveBeenCalledTimes(2);
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.keys).toHaveBeenCalledTimes(1);
  });

  it("does not delete legacy queues when the unified registry save fails", async () => {
    const legacy = [message("first")];
    mocks.values.set("queue:main", legacy);
    mocks.save.mockRejectedValueOnce(new Error("disk full"));

    await expect(loadDurableMessageDeliveries()).rejects.toThrow("disk full");

    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.values.get("queue:main")).toEqual(legacy);
  });

  it("restores legacy queues when their cleanup save fails", async () => {
    const legacy = [message("first")];
    mocks.values.set("queue:main", legacy);
    mocks.save
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(loadDurableMessageDeliveries()).rejects.toThrow(
      "cleanup failed"
    );

    expect(mocks.delete).toHaveBeenCalledWith("queue:main");
    expect(mocks.values.get("queue:main")).toEqual(legacy);
    expect(mocks.values.get("deliveries")).toEqual([durableMessage("first")]);
  });

  it("deduplicates legacy conflicts without replacing unified owners", async () => {
    const current = durableMessage("current");
    const sameIntent = message("same-intent");
    sameIntent.turnIntentId = current.turnIntentId;
    const sameId = message("current");
    sameId.turnIntentId = "turn-other";
    mocks.values.set("deliveries", [current]);
    mocks.values.set("queue:aux", [sameIntent, message("unique")]);
    mocks.values.set("queue:main", [sameId, message("unique")]);

    await loadDurableMessageDeliveries();

    expect(mocks.values.get("deliveries")).toEqual([
      current,
      { ...message("unique"), originQueueKey: "queue:aux" },
    ]);
  });

  it("does not let a stale queue snapshot resurrect an execution twin", async () => {
    mocks.values.set("deliveries", [activeDelivery("first")]);

    await persistDurableMessageQueue([message("first"), message("second")]);

    expect(mocks.values.get("deliveries")).toEqual([
      activeDelivery("first"),
      durableMessage("second"),
    ]);
  });

  it("replaces only this window's queued partition in the single registry", async () => {
    mocks.values.set("deliveries", [
      { ...message("other"), originQueueKey: "queue:aux" },
      durableMessage("stale-main"),
      activeDelivery("running"),
    ]);

    await persistDurableMessageQueue([message("fresh-main")]);

    expect(mocks.values.get("deliveries")).toEqual([
      { ...message("other"), originQueueKey: "queue:aux" },
      activeDelivery("running"),
      durableMessage("fresh-main"),
    ]);
  });

  it("cancels only exact queued owners from this window", async () => {
    const otherWindow = {
      ...message("other-window"),
      originQueueKey: "queue:aux",
    };
    const active = activeDelivery("already-preparing", {
      status: "preparing",
      runnerSessionId: undefined,
    });
    mocks.values.set("deliveries", [
      durableMessage("cancel"),
      durableMessage("keep"),
      otherWindow,
      active,
    ]);

    await expect(
      removeDurableQueuedMessageDeliveries([
        { id: "cancel", turnIntentId: "turn-cancel" },
        { id: "keep", turnIntentId: "wrong-intent" },
        {
          id: "already-preparing",
          turnIntentId: "turn-already-preparing",
        },
        { id: "other-window", turnIntentId: "turn-other-window" },
      ])
    ).resolves.toEqual([message("cancel")]);

    expect(mocks.values.get("deliveries")).toEqual([
      durableMessage("keep"),
      otherWindow,
      active,
    ]);
  });

  it("finds queued and active owners across every window partition", async () => {
    mocks.values.set("deliveries", [
      durableMessage("main"),
      { ...message("other-window"), originQueueKey: "queue:aux" },
      activeDelivery("active"),
    ]);

    await expect(
      findDurableMessageDeliveryOwnerIds([
        "main",
        "other-window",
        "active",
        "orphan",
      ])
    ).resolves.toEqual(new Set(["main", "other-window", "active"]));
  });

  it("atomically hands off, updates, and removes one delivery record", async () => {
    mocks.values.set("deliveries", [durableCanonicalMessage("first")]);
    const preparing = activeDelivery("first", {
      status: "preparing",
      runnerSessionId: undefined,
    });

    const handedOff = await handoffDurableMessageDelivery(preparing);
    expect(handedOff.queue).toEqual([]);
    expect(handedOff.active).toEqual([preparing]);

    const accepted = await updateDurableActiveMessageDelivery("first", {
      status: "accepted",
      runnerSessionId: "runner-first",
    });
    expect(accepted).toMatchObject({
      id: "first",
      status: "accepted",
      runnerSessionId: "runner-first",
    });
    expect(await assertDurableActiveDeliveryIsRootHead("first")).toEqual(
      accepted
    );

    await removeDurableActiveMessageDelivery("first");
    expect(mocks.values.get("deliveries")).toEqual([]);
  });

  it("uses the durable queued payload as authority during handoff", async () => {
    const queued = canonicalMessage("first");
    mocks.values.set("deliveries", [durableCanonicalMessage("first")]);
    const staleCaller = activeDelivery("first", {
      content: "stale in-memory content",
      displayContent: "stale in-memory content",
      status: "preparing",
      runnerSessionId: undefined,
    });

    const result = await handoffDurableMessageDelivery(staleCaller);

    expect(result.delivery.content).toBe(queued.content);
    expect(result.delivery.displayContent).toBe(queued.displayContent);
    expect(result.delivery.status).toBe("preparing");
    expect(mocks.values.get("deliveries")).toEqual([result.delivery]);
  });

  it("keeps an accepted owner when a stale queued twin is handed off", async () => {
    const accepted = activeDelivery("first");
    mocks.values.set("deliveries", [accepted]);

    const result = await handoffDurableMessageDelivery(
      activeDelivery("first", {
        status: "preparing",
        runnerSessionId: undefined,
      })
    );

    expect(result.delivery).toEqual(accepted);
    expect(result.active).toEqual([accepted]);
    expect(result.queue).toEqual([]);
  });

  it("does not hand an edited same-id intent to the existing owner", async () => {
    const owner = activeDelivery("first");
    const edited = canonicalMessage("first");
    edited.turnIntentId = "turn-edited";
    edited.content = "edited body";
    edited.displayContent = "edited body";
    mocks.values.set("deliveries", [
      owner,
      { ...edited, originQueueKey: "queue:main" },
    ]);

    await expect(
      handoffDurableMessageDelivery({
        ...edited,
        conversationDispatch: edited.conversationDispatch!,
        status: "preparing",
      })
    ).rejects.toThrow();

    expect(mocks.values.get("deliveries")).toEqual([
      owner,
      { ...edited, originQueueKey: "queue:main" },
    ]);
  });

  it("returns a pre-accept owner to the claimant queue without losing snapshots", async () => {
    const queued = canonicalMessage("first");
    const preparing = activeDelivery("first", {
      status: "preparing",
      runnerSessionId: undefined,
      modelSelection: {
        model: "gpt-5.6-sol",
        selectedAccountId: "openai-1",
      },
      agentExecMode: "build",
    });
    mocks.values.set("deliveries", [preparing]);
    const restored: QueuedMessage = {
      ...queued,
      modelSelection: preparing.modelSelection,
      agentExecMode: preparing.agentExecMode,
      requiresExplicitDispatch: true,
    };

    const result = await returnDurableMessageDeliveryToQueue("first", restored);

    expect(result.message).toEqual(restored);
    expect(mocks.values.get("deliveries")).toEqual([
      { ...restored, originQueueKey: "queue:main" },
    ]);
  });

  it("keeps a newer same-id queued intent when an older owner returns", async () => {
    const owner = activeDelivery("first");
    const newer = canonicalMessage("first");
    newer.turnIntentId = "turn-newer";
    newer.content = "newer body";
    newer.displayContent = "newer body";
    mocks.values.set("deliveries", [
      owner,
      { ...newer, originQueueKey: "queue:main" },
    ]);

    const result = await returnDurableMessageDeliveryToQueue(
      owner.id,
      canonicalMessage("first")
    );

    expect(result.message).toEqual(newer);
    expect(mocks.values.get("deliveries")).toEqual([
      { ...newer, originQueueKey: "queue:main" },
    ]);
  });

  it("fails closed on an invalid durable row", async () => {
    mocks.values.set("deliveries", [{ id: "truncated" }]);

    await expect(loadDurableMessageQueue()).rejects.toThrow("invalid row");
  });

  it("fails closed on duplicate message or intent identity", async () => {
    mocks.values.set("deliveries", [
      durableMessage("first"),
      { ...durableMessage("second"), id: "first" },
    ]);
    await expect(loadDurableMessageQueue()).rejects.toThrow(
      "duplicate identity"
    );

    mocks.values.set("deliveries", [
      durableMessage("first"),
      { ...durableMessage("second"), turnIntentId: "turn-first" },
    ]);
    await expect(loadDurableMessageQueue()).rejects.toThrow(
      "duplicate identity"
    );
  });

  it("rejects accepted recovery metadata without a native runner", async () => {
    const invalid = activeDelivery("first", {
      runnerSessionId: undefined,
    });
    mocks.values.set("deliveries", [invalid]);

    await expect(loadDurableMessageDeliveries()).rejects.toThrow("invalid row");
  });

  it("rejects active-owner overflow instead of evicting accepted work", async () => {
    mocks.values.set(
      "deliveries",
      Array.from({ length: 100 }, (_, index) =>
        activeDelivery(`active-${index}`, {
          conversationDispatch: {
            ...activeDelivery("template").conversationDispatch,
            root: {
              authority: "local-session",
              authorityScope: [],
              conversationId: `root-${index}`,
            },
          },
        })
      )
    );
    const overflow = canonicalMessage("overflow");
    mocks.values.set("deliveries", [
      ...(mocks.values.get("deliveries") as ActiveMessageDelivery[]),
      { ...overflow, originQueueKey: "queue:main" },
    ]);

    await expect(
      handoffDurableMessageDelivery({
        ...overflow,
        conversationDispatch: overflow.conversationDispatch!,
        status: "preparing",
      })
    ).rejects.toThrow("row limit");
    expect(mocks.values.get("deliveries")).toHaveLength(101);
  });
});
