import { createStore } from "jotai/vanilla";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { eventStoreProxy } from "../../store/EventStoreProxy";
import type { SessionEvent } from "../../types";
import type {
  appendEventsAtom as AppendEventsAtomType,
  loadSessionAtom as LoadSessionAtomType,
} from "../actions";
import type { eventsAtom as EventsAtomType } from "../events";

vi.mock("../../store/EventStoreProxy", () => ({
  eventStoreProxy: {
    append: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    mergeEvents: vi.fn().mockResolvedValue(undefined),
    removeSyntheticUserInputEvents: vi.fn().mockResolvedValue(0),
    scheduleSessionSnapshotRelease: vi.fn(),
    cancelScheduledSnapshotRelease: vi.fn(),
  },
}));

const localStorageStore = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => localStorageStore.get(key) ?? null,
  setItem: (key: string, value: string) => {
    localStorageStore.set(key, value);
  },
  removeItem: (key: string) => {
    localStorageStore.delete(key);
  },
  clear: () => {
    localStorageStore.clear();
  },
});

let appendEventsAtom: typeof AppendEventsAtomType;
let loadSessionAtom: typeof LoadSessionAtomType;
let eventsAtom: typeof EventsAtomType;

beforeAll(async () => {
  ({ appendEventsAtom, loadSessionAtom } = await import("../actions"));
  ({ eventsAtom } = await import("../events"));
});

beforeEach(() => {
  vi.mocked(eventStoreProxy.append).mockClear();
  vi.mocked(eventStoreProxy.set).mockClear();
  vi.mocked(eventStoreProxy.mergeEvents).mockClear();
  vi.mocked(eventStoreProxy.removeSyntheticUserInputEvents).mockClear();
  vi.mocked(eventStoreProxy.scheduleSessionSnapshotRelease).mockClear();
  vi.mocked(eventStoreProxy.cancelScheduledSnapshotRelease).mockClear();
});

function makeMessageEvent(
  id: string,
  sessionId = "session-1",
  createdAt = "2026-05-16T00:00:00.000Z"
): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: id.startsWith("user") ? "user_message" : "message",
    uiCanonical: id.startsWith("user") ? "user_message" : "message",
    actionType: id.startsWith("user") ? "raw" : "message",
    args: {},
    result: id.startsWith("user") ? { message: { content: id } } : {},
    source: id.startsWith("user") ? "user" : "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
  };
}

function makeUserMessageEvent(
  id: string,
  content: string,
  options: { images?: string[]; synthetic?: boolean } = {}
): SessionEvent {
  const event = makeMessageEvent(id);
  return {
    ...event,
    displayText: content,
    result: {
      message: { content },
      ...(options.images ? { images: options.images } : {}),
      ...(options.synthetic ? { syntheticUserInput: true } : {}),
    },
  };
}

describe("loadSessionAtom", () => {
  it("preserves existing same-session rounds when a later load carries only a new tail event", () => {
    const store = createStore();
    const existingEvents = [
      makeMessageEvent("user-round-1", "session-1", "2026-05-16T00:00:01.000Z"),
      makeMessageEvent(
        "assistant-round-1",
        "session-1",
        "2026-05-16T00:00:02.000Z"
      ),
      makeMessageEvent("user-round-2", "session-1", "2026-05-16T00:00:03.000Z"),
      makeMessageEvent(
        "assistant-round-2",
        "session-1",
        "2026-05-16T00:00:04.000Z"
      ),
      makeMessageEvent("user-round-3", "session-1", "2026-05-16T00:00:05.000Z"),
    ];
    const followup = makeMessageEvent(
      "user-round-4",
      "session-1",
      "2026-05-16T00:00:06.000Z"
    );

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: existingEvents,
    });
    store.set(loadSessionAtom, { sessionId: "session-1", events: [followup] });

    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "user-round-1",
      "assistant-round-1",
      "user-round-2",
      "assistant-round-2",
      "user-round-3",
      "user-round-4",
    ]);
  });

  it("preserves existing same-session history when a later load has equal or more events", () => {
    const store = createStore();
    const existingEvents = [
      makeMessageEvent("user-round-1", "session-1", "2026-05-16T00:00:01.000Z"),
      makeMessageEvent(
        "assistant-round-1",
        "session-1",
        "2026-05-16T00:00:02.000Z"
      ),
    ];
    const nextEvents = [
      makeMessageEvent("user-round-2", "session-1", "2026-05-16T00:00:03.000Z"),
      makeMessageEvent(
        "assistant-round-2",
        "session-1",
        "2026-05-16T00:00:04.000Z"
      ),
    ];

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: existingEvents,
    });
    store.set(loadSessionAtom, { sessionId: "session-1", events: nextEvents });

    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "user-round-1",
      "assistant-round-1",
      "user-round-2",
      "assistant-round-2",
    ]);
  });

  it("replaces events when switching to a different session", () => {
    const store = createStore();
    const sessionOneEvents = [makeMessageEvent("user-round-1", "session-1")];
    const sessionTwoEvents = [makeMessageEvent("user-round-1", "session-2")];

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: sessionOneEvents,
    });
    store.set(loadSessionAtom, {
      sessionId: "session-2",
      events: sessionTwoEvents,
    });

    expect(store.get(eventsAtom).map((event) => event.sessionId)).toEqual([
      "session-2",
    ]);
    // Switching away schedules the outgoing session's snapshot release;
    // the incoming session is rescued from any pending release.
    expect(eventStoreProxy.scheduleSessionSnapshotRelease).toHaveBeenCalledWith(
      "session-1"
    );
    expect(eventStoreProxy.cancelScheduledSnapshotRelease).toHaveBeenCalledWith(
      "session-2"
    );
  });

  it("carries optimistic user images onto the persisted echo during load", () => {
    const store = createStore();
    const images = ["data:image/png;base64,AAA"];
    const optimistic = makeUserMessageEvent("user-input-1", "see this", {
      images,
      synthetic: true,
    });
    const persisted = makeUserMessageEvent("user-message-1", "see this");

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [optimistic, persisted],
    });

    expect(store.get(eventsAtom)).toHaveLength(1);
    expect(store.get(eventsAtom)[0].id).toBe("user-message-1");
    expect(store.get(eventsAtom)[0].result?.images).toEqual(images);
  });

  /**
   * Native-transcript replay user events normalize to functionName "user"
   * (the alias map resolves the chunk's action_type "raw"; "user_message"
   * itself is not an alias) under an imported-history id — never the
   * synthetic's user-input-* id.
   */
  function makeReplayEvent(
    id: string,
    content: string,
    role: "user" | "assistant",
    createdAt: string
  ): SessionEvent {
    return {
      ...makeMessageEvent(id, "session-1", createdAt),
      functionName: role === "user" ? "user" : "assistant_message",
      uiCanonical: role === "user" ? "user" : "agent_message",
      actionType: role === "user" ? "raw" : "assistant",
      source: role,
      displayText: content,
      result:
        role === "user"
          ? { type: "user", message: { content, role: "user" } }
          : { content, observation: content },
    };
  }

  it("replace: drops the pre-existing synthetic user event when the replay carries the same content under a different id", () => {
    const store = createStore();
    const synthetic = makeUserMessageEvent("user-input-1", "fix the bug", {
      synthetic: true,
    });
    const streamed = makeMessageEvent(
      "stream-msg-session-1",
      "session-1",
      "2026-05-16T00:00:02.000Z"
    );
    const replayUser = makeReplayEvent(
      "claudecodeapp-user-0",
      "fix the bug",
      "user",
      "2026-05-16T00:00:01.000Z"
    );
    const replayAssistant = makeReplayEvent(
      "claudecodeapp-asst-1",
      "done",
      "assistant",
      "2026-05-16T00:00:03.000Z"
    );

    // Live turn: synthetic user bubble + streamed assistant placeholder.
    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [synthetic, streamed],
    });
    // Turn end: native-transcript reconcile replays the canonical parse.
    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [replayUser, replayAssistant],
      replace: true,
    });

    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "claudecodeapp-user-0",
      "claudecodeapp-asst-1",
    ]);
    // Replace loads must overwrite the Rust store (which still holds the
    // synthetic + streamed placeholders), not merge into it.
    expect(eventStoreProxy.set).toHaveBeenLastCalledWith(
      store.get(eventsAtom),
      "session-1"
    );
  });

  it("without replace, the same reload keeps existing events and merges the replay next to them", () => {
    const store = createStore();
    const synthetic = makeUserMessageEvent("user-input-1", "fix the bug", {
      synthetic: true,
    });
    const streamed = makeMessageEvent(
      "stream-msg-session-1",
      "session-1",
      "2026-05-16T00:00:02.000Z"
    );
    const replayUser = makeReplayEvent(
      "claudecodeapp-user-0",
      "fix the bug",
      "user",
      "2026-05-16T00:00:01.000Z"
    );
    const replayAssistant = makeReplayEvent(
      "claudecodeapp-asst-1",
      "done",
      "assistant",
      "2026-05-16T00:00:03.000Z"
    );

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [synthetic, streamed],
    });
    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [replayUser, replayAssistant],
    });

    // Current merge behavior: existing events survive (only the synthetic
    // is stripped by the backend-user-message fallback) and the replay rows
    // append after them; the Rust store is merged, not replaced.
    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "stream-msg-session-1",
      "claudecodeapp-user-0",
      "claudecodeapp-asst-1",
    ]);
    expect(eventStoreProxy.set).not.toHaveBeenCalled();
    expect(eventStoreProxy.mergeEvents).toHaveBeenLastCalledWith(
      store.get(eventsAtom),
      "session-1"
    );
  });

  it("replace: still recovers the synthetic user event when the replay has no backend user message yet", () => {
    const store = createStore();
    const synthetic = makeUserMessageEvent("user-input-1", "fix the bug", {
      synthetic: true,
    });
    const replayAssistant = makeReplayEvent(
      "claudecodeapp-asst-0",
      "working on it",
      "assistant",
      "2026-05-16T00:00:02.000Z"
    );

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [synthetic],
    });
    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [replayAssistant],
      replace: true,
    });

    // First-message recovery: the native store has not flushed the user
    // turn yet, so the synthetic bubble must not vanish.
    expect(store.get(eventsAtom).map((event) => event.id)).toEqual([
      "user-input-1",
      "claudecodeapp-asst-0",
    ]);
  });

  it("carries optimistic user images onto a live persisted echo", () => {
    const store = createStore();
    const images = ["data:image/png;base64,BBB"];
    const optimistic = makeUserMessageEvent("user-input-1", "see this", {
      images,
      synthetic: true,
    });
    const persisted = makeUserMessageEvent("user-message-1", "see this");

    store.set(loadSessionAtom, {
      sessionId: "session-1",
      events: [optimistic],
    });
    store.set(appendEventsAtom, [persisted]);

    expect(eventStoreProxy.append).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: "user-message-1",
        result: expect.objectContaining({ images }),
      }),
    ]);
  });
});
