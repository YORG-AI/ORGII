// @vitest-environment jsdom
import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type QueuedMessage,
  messageQueueAtom,
  messageQueueHydratedAtom,
} from "@src/store/ui/messageQueueAtom";

import { hydrateMessageQueue } from "../messageQueuePersistence";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("@src/store/ui/messageQueueRepository", () => ({
  loadDurableMessageQueue: mocks.load,
  persistDurableMessageQueue: mocks.persist,
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

describe("messageQueuePersistence", () => {
  beforeEach(() => {
    mocks.load.mockReset().mockResolvedValue([]);
    mocks.persist.mockReset().mockResolvedValue(undefined);
  });

  it("hydrates before opening the dispatch gate", async () => {
    const durable = message("durable");
    mocks.load.mockResolvedValue([durable]);
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

  it("deduplicates by turn intent and lets live mutations win hydration races", async () => {
    const durable = message("durable", { turnIntentId: "shared-intent" });
    const live = message("live", {
      turnIntentId: "shared-intent",
      content: "edited while loading",
    });
    const store = createStore();
    store.set(messageQueueAtom, [live]);
    mocks.load.mockResolvedValue([durable]);

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
});
