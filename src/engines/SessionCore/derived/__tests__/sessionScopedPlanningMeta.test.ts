/**
 * sessionScopedPlanningMetaAtomFamily tests
 *
 * Pins the per-session planning-footer signal derivation: version
 * mirroring, anyRunning from live runtime events, awaiting-user from
 * interactive tools, and reference stability across unchanged snapshots.
 */
import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  noopSessionScopedPlanningMetaAtom,
  sessionScopedPlanningMetaAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";

const subscribers = new Map<string, (snapshot: unknown) => void>();
let latestSnapshots = new Map<string, unknown>();

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getLatestSessionSnapshot: (sessionId: string) =>
      latestSnapshots.get(sessionId) ?? null,
    subscribeSession: (
      sessionId: string,
      listener: (snapshot: unknown) => void
    ) => {
      subscribers.set(sessionId, listener);
      return () => subscribers.delete(sessionId);
    },
    loadFromCache: () => Promise.resolve(),
  },
  isStreamingSnapshot: (snapshot: unknown) =>
    Boolean((snapshot as { streaming?: boolean })?.streaming),
}));

function makeChatEvent(
  id: string,
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id,
    chunk_id: null,
    sessionId: "sub-1",
    createdAt: "2026-06-12T10:00:00Z",
    functionName: "code_search",
    uiCanonical: "code_search",
    actionType: "tool_call",
    args: {},
    result: { content: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    ...overrides,
  } as SessionEvent;
}

function makeSnapshot(chatEvents: SessionEvent[], version = 1) {
  return {
    version,
    eventCount: chatEvents.length,
    events: chatEvents,
    chatEvents,
    sortedSimulatorEvents: [],
    lastEvent: chatEvents.at(-1) ?? null,
    hasRunningEvent: false,
  };
}

function pushSnapshot(sessionId: string, snapshot: unknown) {
  latestSnapshots.set(sessionId, snapshot);
  subscribers.get(sessionId)?.(snapshot);
}

describe("sessionScopedPlanningMetaAtomFamily", () => {
  let store: ReturnType<typeof createStore>;
  let unsub: () => void;

  beforeEach(() => {
    store = createStore();
    latestSnapshots = new Map();
  });

  afterEach(() => {
    unsub?.();
    subscribers.clear();
  });

  function mount(sessionId: string) {
    const metaAtom = sessionScopedPlanningMetaAtomFamily(sessionId);
    unsub = store.sub(metaAtom, () => {});
    return metaAtom;
  }

  it("returns empty meta before any snapshot arrives", () => {
    const metaAtom = mount("sub-empty");
    expect(store.get(metaAtom)).toEqual({
      version: 0,
      anyRunning: false,
      hasAwaitingUserInteraction: false,
      hasRunningAwaitWaitFor: false,
    });
  });

  it("mirrors snapshot version and detects no running work on settled events", () => {
    const metaAtom = mount("sub-1");
    pushSnapshot("sub-1", makeSnapshot([makeChatEvent("grep-1")], 7));
    const meta = store.get(metaAtom);
    expect(meta.version).toBe(7);
    expect(meta.anyRunning).toBe(false);
    expect(meta.hasAwaitingUserInteraction).toBe(false);
  });

  it("flags anyRunning while a tool event is still running", () => {
    const metaAtom = mount("sub-2");
    pushSnapshot(
      "sub-2",
      makeSnapshot(
        [makeChatEvent("grep-running", { displayStatus: "running" })],
        3
      )
    );
    expect(store.get(metaAtom).anyRunning).toBe(true);
  });

  it("flags awaiting-user for an unprocessed interactive tool", () => {
    const metaAtom = mount("sub-3");
    pushSnapshot(
      "sub-3",
      makeSnapshot(
        [
          makeChatEvent("ask-1", {
            functionName: "ask_user_questions",
            uiCanonical: "ask_user_questions",
            displayStatus: "awaiting_user",
            activityStatus: "agent",
          }),
        ],
        4
      )
    );
    const meta = store.get(metaAtom);
    expect(meta.hasAwaitingUserInteraction).toBe(true);
  });

  it("keeps reference stability when signals are unchanged", () => {
    const metaAtom = mount("sub-4");
    pushSnapshot("sub-4", makeSnapshot([makeChatEvent("a")], 5));
    const first = store.get(metaAtom);
    // Same version + same signals → same reference (no downstream rerender).
    pushSnapshot("sub-4", makeSnapshot([makeChatEvent("a")], 5));
    expect(store.get(metaAtom)).toBe(first);
    // Version bump → new reference.
    pushSnapshot("sub-4", makeSnapshot([makeChatEvent("a")], 6));
    expect(store.get(metaAtom)).not.toBe(first);
    expect(store.get(metaAtom).version).toBe(6);
  });

  it("noop atom always returns empty meta", () => {
    expect(store.get(noopSessionScopedPlanningMetaAtom)).toEqual({
      version: 0,
      anyRunning: false,
      hasAwaitingUserInteraction: false,
      hasRunningAwaitWaitFor: false,
    });
  });
});
