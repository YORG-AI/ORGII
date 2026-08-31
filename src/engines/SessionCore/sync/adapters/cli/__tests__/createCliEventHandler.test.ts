/**
 * Ingestion-boundary contract for the CLI event handler.
 *
 * `createCliEventHandler` is where raw CLI/ACP wire frames first become ORGII
 * domain state. Everything below asserts on the state that survives the
 * boundary — the event-store contents, the plan-approval atom, the runtime
 * status atom, the dispatched permission CustomEvent — not on whether a
 * collaborator happened to be called.
 *
 * Only true I/O edges are mocked: the Rust event store (Tauri RPC + `es:changed`
 * listener) and the Rust normalization RPC. `cliLifecycle`, the Jotai atoms,
 * the streaming accumulator and the tool-arg parsers all run for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { sessionRuntimeStatusAtom } from "@src/store/session/cliSessionStatusAtom";
import { pendingPlanApprovalsAtom } from "@src/store/session/planApprovalAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { ActivityChunk } from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import type { EventHandlerCallbacks, RawSessionEvent } from "../../../types";
import {
  MAX_TOOL_CALL_DELTA_BUFFERS,
  MAX_TOOL_CALL_DELTA_CHARS,
} from "../../shared/streamTextAccumulator";
import { createCliEventHandler } from "../createCliEventHandler";

const SESSION_ID = "cliagent-boundary";

/**
 * `MAX_STREAM_CONTENT_LENGTH` in `../../shared/subagentTracking` — module-private,
 * mirrored here so the cap can be asserted without exporting it.
 */
const MAX_STREAM_CONTENT_LENGTH = 500_000;

// ---------------------------------------------------------------------------
// I/O edges
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  const eventsBySession = new Map<string, Record<string, unknown>[]>();
  const streamingLog: Array<{ streaming: boolean; sessionId?: string }> = [];

  const list = (sessionId: string | null | undefined) => {
    const key = sessionId ?? "__unscoped__";
    let events = eventsBySession.get(key);
    if (!events) {
      events = [];
      eventsBySession.set(key, events);
    }
    return events;
  };

  const upsertOne = (
    event: Record<string, unknown>,
    sessionId: string | null | undefined
  ) => {
    const events = list(sessionId ?? (event.sessionId as string | undefined));
    const index = events.findIndex((existing) => existing.id === event.id);
    if (index >= 0) events[index] = { ...events[index], ...event };
    else events.push(event);
  };

  return {
    eventsBySession,
    streamingLog,
    list,
    reset() {
      eventsBySession.clear();
      streamingLog.length = 0;
    },
    api: {
      set: vi.fn(
        async (events: Record<string, unknown>[], sessionId: string) => {
          eventsBySession.set(sessionId, [...events]);
        }
      ),
      append: vi.fn(
        async (events: Record<string, unknown>[], sessionId?: string) => {
          for (const event of events) {
            const bucket = list(sessionId ?? (event.sessionId as string));
            if (bucket.some((existing) => existing.id === event.id)) continue;
            bucket.push(event);
          }
        }
      ),
      upsert: vi.fn(
        async (event: Record<string, unknown>, sessionId?: string) => {
          upsertOne(event, sessionId);
        }
      ),
      mergeEvents: vi.fn(
        async (events: Record<string, unknown>[], sessionId?: string) => {
          for (const event of events) upsertOne(event, sessionId);
        }
      ),
      replaceAndRemove: vi.fn(
        async (
          removeId: string | null,
          newEvent: Record<string, unknown>,
          sessionId?: string
        ) => {
          const bucket = list(
            sessionId ?? (newEvent.sessionId as string | undefined)
          );
          if (removeId) {
            const index = bucket.findIndex((event) => event.id === removeId);
            if (index >= 0) bucket.splice(index, 1);
          }
          upsertOne(newEvent, sessionId);
          return true;
        }
      ),
      getEvents: vi.fn(async (sessionId?: string) => [...list(sessionId)]),
      setStreaming: vi.fn(async (streaming: boolean, sessionId?: string) => {
        streamingLog.push({ streaming, sessionId });
      }),
      pinSession: vi.fn(async () => undefined),
      unpinSession: vi.fn(async () => undefined),
    },
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: store.api,
}));

/**
 * Stand-in for the Rust `normalize_chunk` RPC. Deterministic and total: it
 * mirrors the wire→event field mapping so the tests can talk about ids and
 * `callId` without asserting Rust's exact rendering choices.
 */
const rustBridge = vi.hoisted(() => ({
  normalizeChunkRust: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/ingestion/rustBridge", () => ({
  normalizeChunkRust: rustBridge.normalizeChunkRust,
}));

/**
 * The handler reports a rejected normalize RPC through the logger facade
 * (`createLogger("CliAdapter").warn`), which binds the native console methods
 * at import time — spying on `console.warn` cannot observe it. Only `warn` is
 * swapped; every other level stays real.
 */
const warnMock = vi.hoisted(() => vi.fn());

vi.mock("@src/hooks/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@src/hooks/logger")>();
  return {
    ...actual,
    createLogger: (namespace: string) => ({
      ...actual.createLogger(namespace),
      warn: warnMock,
    }),
  };
});

/**
 * `cliLifecycle` shares the "CliAdapter" namespace, so filter down to the
 * ingestion-failure line this suite is about.
 */
function normalizeFailureWarnings() {
  return warnMock.mock.calls.filter((call) =>
    String(call[0]).includes("normalizeChunkRust failed")
  );
}

/** The "Build card skipped, transcript row kept" line from the same namespace. */
function missingPlanPathWarnings() {
  return warnMock.mock.calls.filter((call) =>
    String(call[0]).includes("plan_approval chunk missing planPath")
  );
}

function normalizeLikeRust(
  chunk: ActivityChunk,
  sessionId: string
): SessionEvent {
  const callId =
    (chunk.result?.tool_call_id as string | undefined) ??
    (chunk.result?.toolCallId as string | undefined);
  const text =
    (chunk.result?.content as string | undefined) ??
    (chunk.result?.observation as string | undefined) ??
    (chunk.result?.thought as string | undefined) ??
    "";
  return {
    id: chunk.chunk_id,
    chunk_id: chunk.chunk_id,
    sessionId,
    createdAt: chunk.created_at,
    functionName: chunk.function,
    uiCanonical: chunk.function,
    actionType: chunk.action_type,
    args: chunk.args ?? {},
    result: chunk.result ?? {},
    source: chunk.action_type === "raw" ? "user" : "assistant",
    displayText: text,
    displayStatus: "completed",
    displayVariant: chunk.action_type === "tool_call" ? "tool_call" : "message",
    activityStatus: "agent",
    ...(callId ? { callId } : {}),
    isDelta: false,
  };
}

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

function makeChunk(overrides: Partial<ActivityChunk>): ActivityChunk {
  return {
    chunk_id: "chunk-1",
    session_id: SESSION_ID,
    action_type: "assistant",
    function: "assistant_message",
    args: {},
    result: {},
    created_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function activityEvent(chunk: ActivityChunk): RawSessionEvent {
  return {
    type: "code_session.activity",
    session_id: SESSION_ID,
    chunk: chunk as unknown as Record<string, unknown>,
  };
}

/** Drains the handler's fire-and-forget promise chains. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function eventsFor(sessionId = SESSION_ID) {
  return store.list(sessionId);
}

interface RecordingCallbacks extends EventHandlerCallbacks {
  agentCompletes: number;
  tokenUpdates: number[];
}

function makeCallbacks(): RecordingCallbacks {
  const recorded: RecordingCallbacks = {
    agentCompletes: 0,
    tokenUpdates: [],
    onAgentComplete: () => {
      recorded.agentCompletes += 1;
    },
    onTokenUpdate: (tokens: number) => {
      recorded.tokenUpdates.push(tokens);
    },
  };
  return recorded;
}

function planApprovalFor(sessionId = SESSION_ID) {
  return (
    getInstrumentedStore().get(pendingPlanApprovalsAtom).get(sessionId)
      ?.current ?? null
  );
}

describe("createCliEventHandler ingestion boundary", () => {
  let callbacks: ReturnType<typeof makeCallbacks>;
  let handler: ReturnType<typeof createCliEventHandler>;

  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    rustBridge.normalizeChunkRust.mockImplementation(
      async (chunk: ActivityChunk, sessionId: string) =>
        normalizeLikeRust(chunk, sessionId)
    );
    createInstrumentedStore();
    const jotai = getInstrumentedStore();
    jotai.set(pendingPlanApprovalsAtom, new Map());
    jotai.set(sessionsAtom, []);
    jotai.set(sessionRuntimeStatusAtom, "idle");
    callbacks = makeCallbacks();
    handler = createCliEventHandler(SESSION_ID, callbacks);
  });

  // -------------------------------------------------------------------------
  // Session routing — the first invariant at the boundary
  // -------------------------------------------------------------------------

  describe("session routing", () => {
    it("drops every frame addressed to another session", async () => {
      handler.handleEvent({
        type: "code_session.activity",
        session_id: "cliagent-other",
        chunk: makeChunk({
          action_type: "assistant",
          result: { content: "not mine", is_delta: true },
        }) as unknown as Record<string, unknown>,
      });
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: "cliagent-other",
        status: "completed",
      });
      await flush();

      expect(store.eventsBySession.size).toBe(0);
      expect(handler.isStreaming).toBe(false);
      expect(callbacks.agentCompletes).toBe(0);
    });

    it("drops frames that carry no session id at all", async () => {
      handler.handleEvent({
        type: "code_session.activity",
        chunk: makeChunk({}) as unknown as Record<string, unknown>,
      });
      await flush();

      expect(store.eventsBySession.size).toBe(0);
    });

    it("accepts the camelCase `sessionId` spelling as well as snake_case", async () => {
      handler.handleEvent({
        type: "code_session.token_usage_updated",
        sessionId: SESSION_ID,
        total_tokens: 42,
      });

      expect(callbacks.tokenUpdates).toEqual([42]);
    });
  });

  // -------------------------------------------------------------------------
  // Forward compatibility
  // -------------------------------------------------------------------------

  describe("forward compatibility", () => {
    it("ignores unknown top-level event kinds without touching state", async () => {
      handler.handleEvent({
        type: "code_session.some_future_kind",
        session_id: SESSION_ID,
        payload: { anything: true },
      });
      handler.handleEvent({
        type: "agent:not_a_real_event",
        session_id: SESSION_ID,
      });
      await flush();

      expect(store.eventsBySession.size).toBe(0);
      expect(handler.isStreaming).toBe(false);
    });

    it("ignores a `code_session.activity` frame with no chunk", async () => {
      handler.handleEvent({
        type: "code_session.activity",
        session_id: SESSION_ID,
      });
      await flush();

      expect(rustBridge.normalizeChunkRust).not.toHaveBeenCalled();
      expect(store.eventsBySession.size).toBe(0);
    });

    it("routes an unknown action_type through the generic normalize+append path", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "chunk-future",
            action_type: "brand_new_action",
            function: "brand_new",
            result: { observation: "hi" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["chunk-future"]);
    });

    it("logs the failure and stores nothing when the normalize RPC rejects", async () => {
      // The previous shape of this test only wrapped the dispatch in
      // `expect(...).not.toThrow()`. That can never fail: the rejection lives
      // inside a fire-and-forget promise chain and has no synchronous path to
      // the caller. The real contract is that every lane's `.catch` reports the
      // dropped chunk — silence here means an invisible hole in the transcript.
      rustBridge.normalizeChunkRust.mockRejectedValue(
        new Error("rust ingestion unavailable")
      );

      // Both lanes: the final message/thinking lane and the generic lane.
      handler.handleEvent(
        activityEvent(makeChunk({ chunk_id: "chunk-doomed" }))
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "tool-doomed",
            action_type: "tool_call",
            function: "read_file",
          })
        )
      );
      await flush();

      expect(store.eventsBySession.size).toBe(0);
      const warnings = normalizeFailureWarnings();
      expect(warnings).toHaveLength(2);
      for (const call of warnings) {
        expect(call[1]).toBeInstanceOf(Error);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Streaming deltas
  // -------------------------------------------------------------------------

  describe("assistant / thinking streaming", () => {
    it("accumulates message deltas under one stable stream id", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "d1",
            action_type: "assistant_delta",
            result: { content: "Hello ", is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "d2",
            action_type: "assistant_delta",
            result: { content: "world", is_delta: true },
          })
        )
      );
      await flush();

      const events = eventsFor();
      expect(events).toHaveLength(1);
      expect(events[0].id).toMatch(/^stream-msg-ts-/);
      expect(events[0].displayText).toBe("Hello world");
      expect(events[0].createdAt).toBe("2026-08-01T00:00:00.000Z");
      expect(handler.isStreaming).toBe(true);
      expect(store.streamingLog).toEqual([
        { streaming: true, sessionId: SESSION_ID },
      ]);
    });

    it("is idempotent for a cumulative snapshot replay of the same stream", async () => {
      const send = (content: string) =>
        handler.handleEvent(
          activityEvent(
            makeChunk({
              action_type: "message_delta",
              result: { content, is_delta: true },
            })
          )
        );

      send("The assistant starts here");
      send("The assistant starts here and keeps going");
      // Exact replay of the whole visible stream.
      send("The assistant starts here and keeps going");
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(eventsFor()[0].displayText).toBe(
        "The assistant starts here and keeps going"
      );
    });

    it("is idempotent for a cumulative snapshot replay of the thinking stream", async () => {
      // Mirrors the message-lane test above. The thinking lane runs the same
      // `mergeStreamingText` guard on its own accumulator; without a test here
      // a blind `thinkContent + deltaText` regression is invisible, and a
      // reconnect replays the whole reasoning block into the card twice.
      const send = (thought: string) =>
        handler.handleEvent(
          activityEvent(
            makeChunk({
              action_type: "llm_thinking_delta",
              result: { thought, is_delta: true },
            })
          )
        );

      send("The model starts reasoning");
      send("The model starts reasoning and keeps going");
      // Exact replay of the whole visible stream.
      send("The model starts reasoning and keeps going");
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(eventsFor()[0].displayText).toBe(
        "The model starts reasoning and keeps going"
      );
    });

    it("caps the live message buffer instead of growing it without bound", async () => {
      // `capStreamContent` is the only thing standing between a runaway
      // provider and an unbounded in-memory string that is re-upserted on
      // every delta. Nothing else in this suite observes that it trims.
      const send = (content: string) =>
        handler.handleEvent(
          activityEvent(
            makeChunk({
              action_type: "assistant_delta",
              result: { content, is_delta: true },
            })
          )
        );

      send("a".repeat(400_000));
      send("b".repeat(300_000));
      await flush();

      const text = String(eventsFor()[0].displayText);
      expect(text).toHaveLength(MAX_STREAM_CONTENT_LENGTH);
      // Trimmed from the front: the oldest text is what gets dropped.
      expect(text.startsWith("a")).toBe(true);
      expect(text.endsWith("b")).toBe(true);
    });

    it("caps the live thinking buffer on the same budget", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { thought: "c".repeat(400_000), is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { thought: "d".repeat(300_000), is_delta: true },
          })
        )
      );
      await flush();

      expect(String(eventsFor()[0].displayText)).toHaveLength(
        MAX_STREAM_CONTENT_LENGTH
      );
    });

    it("reads delta text from `observation` when `content` is absent", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "message_delta",
            result: { observation: "from observation", is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { observation: " and thinking too", is_delta: true },
          })
        )
      );
      await flush();

      const texts = eventsFor().map((event) => event.displayText);
      expect(texts).toContain("from observation");
      expect(texts).toContain(" and thinking too");
    });

    it("emits an empty placeholder rather than dropping a delta with no text", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { is_delta: true },
          })
        )
      );
      await flush();

      expect(eventsFor()).toHaveLength(2);
      expect(eventsFor().map((event) => event.displayText)).toEqual(["", ""]);
    });

    it("reads a thinking delta's text from `content` when `thought` is absent", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { content: "reasoning via content", is_delta: true },
          })
        )
      );
      await flush();

      expect(eventsFor()[0].displayText).toBe("reasoning via content");
    });

    it("swallows the CLI's own echo of the user message", async () => {
      for (const actionType of ["raw", "raw_event"]) {
        handler.handleEvent(
          activityEvent(
            makeChunk({
              chunk_id: `echo-${actionType}`,
              action_type: actionType,
              function: "user_message",
              result: { content: "the prompt" },
            })
          )
        );
      }
      await flush();

      expect(rustBridge.normalizeChunkRust).not.toHaveBeenCalled();
      expect(store.eventsBySession.size).toBe(0);
    });

    it("keeps thinking and message streams in separate events", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            function: "thinking",
            result: { thought: "pondering", is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "answer", is_delta: true },
          })
        )
      );
      await flush();

      const ids = eventsFor().map((event) => String(event.id));
      expect(ids).toHaveLength(2);
      expect(ids.some((id) => id.startsWith("stream-think-ts-"))).toBe(true);
      expect(ids.some((id) => id.startsWith("stream-msg-ts-"))).toBe(true);
      expect(
        eventsFor().find((event) => String(event.id).startsWith("stream-think"))
      ).toMatchObject({ displayText: "pondering" });
    });

    it("falls back to wall-clock createdAt when the chunk omits created_at", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            created_at: "",
            result: { content: "x", is_delta: true },
          })
        )
      );
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            created_at: "",
            result: { thought: "y", is_delta: true },
          })
        )
      );
      await flush();

      for (const event of eventsFor()) {
        const createdAt = String(event.createdAt);
        expect(createdAt).not.toBe("");
        expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
      }
    });

    it("replaces the typewriter placeholder with the final normalized event", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "partial", is_delta: true },
          })
        )
      );
      await flush();
      const placeholderId = String(eventsFor()[0].id);

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "final-msg",
            action_type: "assistant",
            result: { content: "partial answer" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["final-msg"]);
      expect(store.api.replaceAndRemove).toHaveBeenCalledWith(
        placeholderId,
        expect.objectContaining({ id: "final-msg" }),
        SESSION_ID
      );
    });

    it("appends a final message that never had a live placeholder", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "solo-final",
            action_type: "message",
            result: { content: "whole answer at once" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["solo-final"]);
      expect(store.api.replaceAndRemove).not.toHaveBeenCalled();
      expect(store.api.append).toHaveBeenCalledTimes(1);
    });

    it("replaces the thinking placeholder with the final thinking chunk", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { thought: "half", is_delta: true },
          })
        )
      );
      await flush();
      const placeholderId = String(eventsFor()[0].id);

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "final-think",
            action_type: "llm_thinking",
            function: "thinking",
            result: { thought: "half a thought, finished" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["final-think"]);
      expect(store.api.replaceAndRemove).toHaveBeenCalledWith(
        placeholderId,
        expect.objectContaining({ id: "final-think" }),
        SESSION_ID
      );
    });

    it("re-asserts the terminal status when a final chunk lands after it", async () => {
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "completed",
      });
      await flush();
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "completed"
      );
      getInstrumentedStore().set(sessionRuntimeStatusAtom, "idle");

      // Out-of-order: the provider flushes its last assistant chunk after the
      // process already reported a terminal status.
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "trailing-final",
            action_type: "assistant",
            result: { content: "trailing" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["trailing-final"]);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "completed"
      );
    });

    it("mints a fresh stream id for the next turn after the placeholder is replaced", async () => {
      const delta = () =>
        handler.handleEvent(
          activityEvent(
            makeChunk({
              action_type: "assistant_delta",
              result: { content: "a", is_delta: true },
            })
          )
        );

      delta();
      await flush();
      const firstStreamId = String(eventsFor()[0].id);

      handler.handleEvent(
        activityEvent(
          makeChunk({ chunk_id: "final-1", action_type: "assistant" })
        )
      );
      await flush();

      delta();
      await flush();
      const secondStreamId = String(
        eventsFor().find((event) => String(event.id).startsWith("stream-msg"))
          ?.id
      );
      expect(secondStreamId).toBeDefined();
      expect(secondStreamId).not.toBe(firstStreamId);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency / replay
  // -------------------------------------------------------------------------

  describe("duplicate and replayed finalizations", () => {
    const completeEvent: SessionEvent = {
      id: "stream-msg-cliagent-boundary",
      chunk_id: null,
      sessionId: SESSION_ID,
      createdAt: "2026-08-01T00:00:01.000Z",
      functionName: "assistant_message",
      uiCanonical: "assistant_message",
      actionType: "assistant",
      args: {},
      result: { content: "final" },
      source: "assistant",
      displayText: "final",
      displayStatus: "completed",
      displayVariant: "message",
      activityStatus: "agent",
    };

    function streamingComplete(
      event: SessionEvent,
      streamType?: string
    ): RawSessionEvent {
      return {
        type: "agent:streaming_complete",
        session_id: SESSION_ID,
        payload: { event, ...(streamType ? { streamType } : {}) },
      };
    }

    it("stores the completion once, no matter how many times it is replayed", async () => {
      handler.handleEvent(streamingComplete(completeEvent, "message"));
      handler.handleEvent(streamingComplete(completeEvent, "message"));
      handler.handleEvent(streamingComplete(completeEvent, "message"));
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual([completeEvent.id]);
      expect(store.api.upsert).toHaveBeenCalledTimes(1);
      expect(store.api.replaceAndRemove).not.toHaveBeenCalled();
    });

    it("swaps the live placeholder out when the completion carries a new id", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "partial", is_delta: true },
          })
        )
      );
      await flush();
      expect(eventsFor()).toHaveLength(1);

      handler.handleEvent(streamingComplete(completeEvent, "message"));
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual([completeEvent.id]);
    });

    it("suppresses a late final activity chunk that repeats a completed id", async () => {
      handler.handleEvent(streamingComplete(completeEvent, "message"));
      await flush();
      store.api.append.mockClear();

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: completeEvent.id,
            action_type: "assistant",
            result: { content: "final" },
          })
        )
      );
      await flush();

      expect(store.api.append).not.toHaveBeenCalled();
      expect(eventsFor()).toHaveLength(1);
    });

    it("bounds the finalized-id memo, so an id evicted after 256 newer ones is accepted again", async () => {
      const idAt = (index: number) => `stream-msg-bounded-${index}`;
      // 257 distinct completions push the very first id out of the 256-slot memo.
      for (let index = 0; index < 257; index += 1) {
        handler.handleEvent(
          streamingComplete({ ...completeEvent, id: idAt(index) }, "message")
        );
      }
      await flush();
      expect(eventsFor()).toHaveLength(257);
      store.api.upsert.mockClear();

      // A recent id is still remembered — replay is a no-op.
      handler.handleEvent(
        streamingComplete({ ...completeEvent, id: idAt(256) }, "message")
      );
      await flush();
      expect(store.api.upsert).not.toHaveBeenCalled();

      // The evicted id is no longer remembered and is re-ingested.
      handler.handleEvent(
        streamingComplete({ ...completeEvent, id: idAt(0) }, "message")
      );
      await flush();
      expect(store.api.upsert).toHaveBeenCalledTimes(1);
      expect(eventsFor()).toHaveLength(257);
    });

    it("upserts an unknown streamType instead of dropping it", async () => {
      handler.handleEvent(streamingComplete(completeEvent, "future_kind"));
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual([completeEvent.id]);
    });

    it("ignores a streaming_complete frame with no event payload", async () => {
      handler.handleEvent({
        type: "agent:streaming_complete",
        session_id: SESSION_ID,
        payload: { streamType: "message" },
      });
      handler.handleEvent({
        type: "agent:streaming_complete",
        session_id: SESSION_ID,
      });
      await flush();

      expect(store.eventsBySession.size).toBe(0);
    });

    it("upserts a thinking completion that arrived with no live placeholder", async () => {
      const thinkingComplete: SessionEvent = {
        ...completeEvent,
        id: "stream-think-cliagent-boundary",
        actionType: "llm_thinking",
        displayVariant: "thinking",
      };

      handler.handleEvent(streamingComplete(thinkingComplete, "thinking"));
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual([
        thinkingComplete.id,
      ]);
      expect(store.api.replaceAndRemove).not.toHaveBeenCalled();
      expect(store.api.upsert).toHaveBeenCalledTimes(1);
    });

    it("clears the thinking placeholder on a thinking completion", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "llm_thinking_delta",
            result: { thought: "half a thought", is_delta: true },
          })
        )
      );
      await flush();
      const placeholderId = String(eventsFor()[0].id);

      const thinkingComplete: SessionEvent = {
        ...completeEvent,
        id: "stream-think-cliagent-boundary",
        actionType: "llm_thinking",
        displayVariant: "thinking",
      };
      handler.handleEvent(streamingComplete(thinkingComplete, "thinking"));
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual([
        thinkingComplete.id,
      ]);
      expect(store.api.replaceAndRemove).toHaveBeenCalledWith(
        placeholderId,
        expect.objectContaining({ id: thinkingComplete.id }),
        SESSION_ID
      );
    });
  });

  // -------------------------------------------------------------------------
  // Tool-call deltas
  // -------------------------------------------------------------------------

  describe("tool_call_delta accumulation", () => {
    function toolDelta(
      result: Record<string, unknown>,
      chunkId = `td-${Math.random()}`
    ): RawSessionEvent {
      return activityEvent(
        makeChunk({
          chunk_id: chunkId,
          action_type: "tool_call_delta",
          function: "tool_call",
          result,
        })
      );
    }

    it("buffers silently until a tool_call_id arrives, then emits the whole accumulation", async () => {
      handler.handleEvent(
        toolDelta({ index: 0, arguments_delta: '{"file_path":"/tmp/a' })
      );
      await flush();
      // No id yet: nothing may reach the store, because a tool-call event
      // without a callId can never be paired with its result.
      expect(store.eventsBySession.size).toBe(0);

      handler.handleEvent(
        toolDelta({
          index: 0,
          tool_call_id: "call-1",
          tool_name: "read_file",
          arguments_delta: '.txt"}',
        })
      );
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(eventsFor()[0]).toMatchObject({
        id: "tool-call-call-1",
        callId: "call-1",
        functionName: "read_file",
        displayStatus: "running",
        isDelta: true,
        args: { file_path: "/tmp/a.txt" },
      });
      expect(handler.isStreaming).toBe(true);
    });

    it("accepts the camelCase delta field spellings", async () => {
      handler.handleEvent(
        toolDelta({
          index: 0,
          toolCallId: "call-camel",
          toolName: "write_file",
          argumentsDelta: '{"path":"/tmp/b.txt"}',
        })
      );
      await flush();

      expect(eventsFor()[0]).toMatchObject({
        id: "tool-call-call-camel",
        functionName: "write_file",
        args: { file_path: "/tmp/b.txt" },
      });
    });

    it("keeps concurrent tool calls on separate buffers keyed by index", async () => {
      handler.handleEvent(
        toolDelta({
          index: 0,
          tool_call_id: "call-a",
          tool_name: "read_file",
          arguments_delta: '{"file_path":"/a"}',
        })
      );
      handler.handleEvent(
        toolDelta({
          index: 1,
          tool_call_id: "call-b",
          tool_name: "read_file",
          arguments_delta: '{"file_path":"/b"}',
        })
      );
      await flush();

      expect(
        eventsFor()
          .map((event) => event.id)
          .sort()
      ).toEqual(["tool-call-call-a", "tool-call-call-b"]);
    });

    it("treats a missing index as index 0 (all such deltas share one buffer)", async () => {
      handler.handleEvent(
        toolDelta({ tool_call_id: "call-x", arguments_delta: '{"path":"/x"' })
      );
      // A frame that carries no argument text at all must not disturb the
      // accumulation or re-emit stale args.
      handler.handleEvent(toolDelta({}));
      handler.handleEvent(toolDelta({ arguments_delta: "}" }));
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(eventsFor()[0]).toMatchObject({
        id: "tool-call-call-x",
        args: { file_path: "/x" },
      });
    });

    it("retires the delta buffer once the authoritative tool_call lands", async () => {
      handler.handleEvent(
        toolDelta({
          index: 0,
          tool_call_id: "call-1",
          tool_name: "read_file",
          arguments_delta: '{"file_path":"/first"}',
        })
      );
      await flush();

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "tool-call-final",
            action_type: "tool_call",
            function: "read_file",
            result: { tool_call_id: "call-1" },
          })
        )
      );
      await flush();

      // A fresh delta at the same index must not resurrect the retired args.
      handler.handleEvent(
        toolDelta({
          index: 0,
          tool_call_id: "call-2",
          tool_name: "read_file",
          arguments_delta: '{"file_path":"/second"}',
        })
      );
      await flush();

      const second = eventsFor().find(
        (event) => event.id === "tool-call-call-2"
      );
      expect(second).toMatchObject({ args: { file_path: "/second" } });
    });

    it("stops accumulating argument text once the per-call cap is reached", async () => {
      // `appendBoundedToolCallArgs` is the only bound on a tool-call argument
      // stream. A provider that never closes its JSON would otherwise pin an
      // unbounded string per in-flight call for the life of the session.
      const head = '{"file_path":"/a"';
      const filler = "x".repeat(MAX_TOOL_CALL_DELTA_CHARS - head.length - 5);

      handler.handleEvent(
        toolDelta({
          index: 0,
          tool_call_id: "call-cap",
          tool_name: "edit",
          arguments_delta: head + filler,
        })
      );
      // Only the first 5 characters of this fit under the cap, so the
      // `"command"` key never completes and cannot be parsed out.
      handler.handleEvent(
        toolDelta({ index: 0, arguments_delta: ',"command":"ls"}' })
      );
      await flush();

      const event = eventsFor().find(
        (candidate) => candidate.id === "tool-call-call-cap"
      );
      expect(event?.args).toEqual({ file_path: "/a" });
    });

    it("evicts the oldest delta buffer once every slot is taken", async () => {
      // `makeRoomForToolCallDelta` bounds how many concurrent tool calls can
      // hold a buffer. Without it a long session leaks one accumulator per
      // index the provider ever used.
      for (let index = 0; index < MAX_TOOL_CALL_DELTA_BUFFERS; index += 1) {
        handler.handleEvent(
          toolDelta(
            { index, arguments_delta: `{"file_path":"/f${index}"` },
            `fill-${index}`
          )
        );
      }
      await flush();
      // No tool_call_id on any of them, so nothing has reached the store yet.
      expect(store.eventsBySession.size).toBe(0);

      // One index past the budget: the oldest buffer (index 0) is dropped.
      handler.handleEvent(
        toolDelta(
          {
            index: MAX_TOOL_CALL_DELTA_BUFFERS,
            arguments_delta: `{"file_path":"/f${MAX_TOOL_CALL_DELTA_BUFFERS}"`,
          },
          "fill-overflow"
        )
      );
      await flush();

      // Index 0's accumulation is gone — a late id-bearing frame starts empty.
      handler.handleEvent(
        toolDelta(
          { index: 0, tool_call_id: "call-evicted", arguments_delta: '"}' },
          "evicted"
        )
      );
      // The newest buffer survived and still carries its args.
      handler.handleEvent(
        toolDelta(
          {
            index: MAX_TOOL_CALL_DELTA_BUFFERS,
            tool_call_id: "call-kept",
            arguments_delta: '"}',
          },
          "kept"
        )
      );
      await flush();

      const byId = (id: string) =>
        eventsFor().find((candidate) => candidate.id === id);
      expect(byId("tool-call-call-evicted")?.args).toEqual({});
      expect(byId("tool-call-call-kept")?.args).toEqual({
        file_path: `/f${MAX_TOOL_CALL_DELTA_BUFFERS}`,
      });
    });

    it("does not append a duplicate row for an authoritative tool_call (upsert semantics)", async () => {
      const toolCall = activityEvent(
        makeChunk({
          chunk_id: "tool-call-final",
          action_type: "tool_call",
          function: "read_file",
          result: { tool_call_id: "call-9", status: "running" },
        })
      );
      handler.handleEvent(toolCall);
      await flush();
      handler.handleEvent(toolCall);
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(store.api.append).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Status transitions
  // -------------------------------------------------------------------------

  describe("status transitions", () => {
    it("closes the turn on a terminal status and mirrors it into the runtime atom", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "mid-flight", is_delta: true },
          })
        )
      );
      await flush();
      expect(handler.isStreaming).toBe(true);

      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "completed",
      });
      await flush();

      expect(handler.isStreaming).toBe(false);
      expect(callbacks.agentCompletes).toBe(1);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "completed"
      );
      expect(store.streamingLog.at(-1)).toEqual({
        streaming: false,
        sessionId: SESSION_ID,
      });
    });

    it("force-closes still-running events when the session ends", async () => {
      await store.api.upsert(
        {
          id: "running-tool",
          sessionId: SESSION_ID,
          displayStatus: "running",
          activityStatus: "agent",
          result: { status: "running" },
          args: {},
        },
        SESSION_ID
      );

      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "failed",
      });
      await flush();

      expect(
        eventsFor().find((event) => event.id === "running-tool")
      ).toMatchObject({
        displayStatus: "failed",
        activityStatus: "processed",
        isDelta: false,
        result: { status: "failed" },
      });
    });

    it("ignores a status string outside the CLI status vocabulary", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "still going", is_delta: true },
          })
        )
      );
      await flush();

      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "quantum_superposition",
      });
      await flush();

      expect(handler.isStreaming).toBe(true);
      expect(callbacks.agentCompletes).toBe(0);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe("idle");
    });

    it("does not treat a non-terminal status as completion", async () => {
      for (const status of ["idle", "pending", "paused", "waiting_for_user"]) {
        handler.handleEvent({
          type: "code_session.status_changed",
          session_id: SESSION_ID,
          status,
        });
      }
      await flush();

      expect(callbacks.agentCompletes).toBe(0);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe("idle");
    });

    it("fires onAgentComplete once per terminal status, including after a restart", async () => {
      // Renamed from "no coalescing across a restart": the callback count says
      // nothing about the restart itself. The observed-terminal-status reset
      // that a restart performs is pinned by the next test.
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "cancelled",
      });
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "running",
      });
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "completed",
      });
      await flush();

      expect(callbacks.agentCompletes).toBe(2);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe(
        "completed"
      );
    });

    it("forgets the observed terminal status once the session runs again", async () => {
      // The counterpart of "re-asserts the terminal status when a final chunk
      // lands after it": once a NEW run has started, a trailing chunk from the
      // previous turn must not resurrect the old terminal status and close the
      // live turn out from under the user.
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "completed",
      });
      await flush();
      handler.handleEvent({
        type: "code_session.status_changed",
        session_id: SESSION_ID,
        status: "running",
      });
      await flush();
      getInstrumentedStore().set(sessionRuntimeStatusAtom, "idle");

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "trailing-final",
            action_type: "assistant",
            result: { content: "trailing" },
          })
        )
      );
      await flush();

      expect(eventsFor().map((event) => event.id)).toEqual(["trailing-final"]);
      expect(getInstrumentedStore().get(sessionRuntimeStatusAtom)).toBe("idle");
    });
  });

  // -------------------------------------------------------------------------
  // Token usage
  // -------------------------------------------------------------------------

  describe("token usage", () => {
    it("forwards only numeric totals", () => {
      handler.handleEvent({
        type: "code_session.token_usage_updated",
        session_id: SESSION_ID,
        total_tokens: 1234,
      });
      handler.handleEvent({
        type: "code_session.token_usage_updated",
        session_id: SESSION_ID,
        total_tokens: "9999",
      });
      handler.handleEvent({
        type: "code_session.token_usage_updated",
        session_id: SESSION_ID,
      });

      expect(callbacks.tokenUpdates).toEqual([1234]);
    });
  });

  // -------------------------------------------------------------------------
  // Plan approval
  // -------------------------------------------------------------------------

  describe("plan approval lifecycle", () => {
    it("records a pending plan and defaults the optional text fields", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        planRevisionId: "rev-1",
        autoApproveAt: 1700000000000,
      });

      expect(planApprovalFor()).toEqual({
        sessionId: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        planTitle: "",
        planContent: "",
        toolCallId: undefined,
        planId: undefined,
        planRevisionId: "rev-1",
        originToolCallId: undefined,
        autoApproveAt: 1700000000000,
      });
    });

    it("refuses to create a pending plan without a planPath", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planTitle: "orphan",
      });
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "",
      });

      expect(planApprovalFor()).toBeNull();
    });

    it("coerces a non-finite autoApproveAt to null rather than storing NaN", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        autoApproveAt: Number.NaN,
      });

      expect(planApprovalFor()?.autoApproveAt).toBeNull();
    });

    it("lets a newer revision supersede the pending plan", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        planRevisionId: "rev-1",
      });
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/b.md",
        planRevisionId: "rev-2",
      });

      expect(planApprovalFor()).toMatchObject({
        planPath: "/repo/.plans/b.md",
        planRevisionId: "rev-2",
      });
    });

    it("clears the pending plan on exit_plan_mode", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        toolCallId: "call-plan",
      });
      handler.handleEvent({
        type: "agent:exit_plan_mode",
        session_id: SESSION_ID,
        toolCallId: "call-plan",
      });

      expect(planApprovalFor()).toBeNull();
    });

    it("clears unconditionally when exit_plan_mode carries no toolCallId", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        planRevisionId: "rev-1",
      });
      handler.handleEvent({
        type: "agent:exit_plan_mode",
        session_id: SESSION_ID,
      });

      expect(planApprovalFor()).toBeNull();
    });

    it("falls back to toolCallId when an archived broadcast omits the revision id", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        toolCallId: "call-plan",
      });
      handler.handleEvent({
        type: "agent:plan_approval_archived",
        session_id: SESSION_ID,
        toolCallId: "call-plan",
      });

      expect(planApprovalFor()).toBeNull();
    });

    it("clears the pending plan on an archived broadcast keyed by revision id", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/a.md",
        planRevisionId: "rev-1",
      });
      handler.handleEvent({
        type: "agent:plan_approval_archived",
        session_id: SESSION_ID,
        planRevisionId: "rev-1",
      });

      expect(planApprovalFor()).toBeNull();
    });

    it("keeps a live plan when an archived broadcast names a different revision", () => {
      handler.handleEvent({
        type: "agent:plan_ready_for_approval",
        session_id: SESSION_ID,
        planPath: "/repo/.plans/b.md",
        planRevisionId: "rev-2",
      });
      handler.handleEvent({
        type: "agent:plan_approval_archived",
        session_id: SESSION_ID,
        planRevisionId: "rev-1",
      });

      expect(planApprovalFor()).toMatchObject({ planRevisionId: "rev-2" });
    });

    it("stores a plan_approval activity chunk AND the pending plan", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "plan-chunk",
            action_type: "plan_approval",
            function: "plan_approval",
            args: {
              planPath: "/repo/.plans/a.md",
              title: "Do the thing",
              content: "## steps",
              planRevisionId: "rev-7",
              planId: "plan-7",
            },
          })
        )
      );
      await flush();

      expect(planApprovalFor()).toMatchObject({
        planPath: "/repo/.plans/a.md",
        planTitle: "Do the thing",
        planContent: "## steps",
        planRevisionId: "rev-7",
        toolCallId: "rev-7",
        planId: "plan-7",
      });
      expect(eventsFor().map((event) => event.id)).toEqual(["plan-chunk"]);
    });

    it("records the pending plan before the normalize RPC, and logs when it rejects", async () => {
      // The Build card is not allowed to depend on Rust normalization: the
      // atom write happens synchronously, ahead of the RPC. Moving it into the
      // `.then()` would strand the plan on every ingestion failure — that
      // ordering is what the pre-`flush()` assertion below pins.
      rustBridge.normalizeChunkRust.mockRejectedValueOnce(
        new Error("rust ingestion unavailable")
      );

      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "plan-chunk",
            action_type: "plan_approval",
            function: "plan_approval",
            args: { planPath: "/repo/.plans/a.md" },
          })
        )
      );
      expect(planApprovalFor()).toMatchObject({
        planPath: "/repo/.plans/a.md",
      });
      await flush();

      expect(planApprovalFor()).toMatchObject({
        planPath: "/repo/.plans/a.md",
      });
      expect(store.eventsBySession.size).toBe(0);
      // The dropped chunk must leave a trace; the plan card alone does not
      // tell anyone the transcript row went missing.
      expect(normalizeFailureWarnings()).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // A `plan_approval` chunk with no `planPath` feeds only ONE of the two
    // sinks. The Build card keys off the path (that is where an approval
    // writes the file back), so no path means no card. The transcript row
    // does not: `PlanDocAdapter` renders from `title` / `content` / the plan
    // ids and never reads `planPath`.
    //
    // Both used to sit behind the same guard, so the plan vanished from the
    // transcript entirely, with nothing logged. Rust emits `"planPath": ""`
    // whenever the snapshot has no path, and the handler's `asString` rejects
    // `""` — so this is the ordinary empty-path case, not a malformed frame.
    // -----------------------------------------------------------------------

    it("stores a plan_approval chunk in the transcript even with no planPath", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            chunk_id: "plan-chunk-bad",
            action_type: "plan_approval",
            function: "plan_approval",
            args: { title: "no path" },
          })
        )
      );
      await flush();

      // A missing planPath means "no Build card", not "no transcript row".
      expect(planApprovalFor()).toBeNull();
      expect(eventsFor().map((event) => event.id)).toEqual(["plan-chunk-bad"]);
      // The skipped card must leave a trace naming the field that was missing.
      const warnings = missingPlanPathWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toBe("plan-chunk-bad");
      expect(normalizeFailureWarnings()).toHaveLength(0);
    });

    it("keeps the transcript row for a plan_approval frame with no args at all", async () => {
      handler.handleEvent(
        activityEvent({
          ...makeChunk({
            chunk_id: "plan-chunk-argless",
            action_type: "plan_approval",
            function: "plan_approval",
          }),
          args: undefined as unknown as Record<string, unknown>,
        })
      );
      await flush();

      expect(planApprovalFor()).toBeNull();
      expect(eventsFor().map((event) => event.id)).toEqual([
        "plan-chunk-argless",
      ]);
      expect(missingPlanPathWarnings()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Permission requests
  // -------------------------------------------------------------------------

  describe("permission requests", () => {
    let dispatched: CustomEvent[];
    let originalDispatch: typeof window.dispatchEvent;

    beforeEach(() => {
      dispatched = [];
      originalDispatch = window.dispatchEvent;
      window.dispatchEvent = ((event: Event) => {
        dispatched.push(event as CustomEvent);
        return true;
      }) as typeof window.dispatchEvent;
    });

    afterEach(() => {
      window.dispatchEvent = originalDispatch;
    });

    it("dispatches a fully formed permission request for cli_hook origin", () => {
      handler.handleEvent({
        type: "permission:request",
        session_id: SESSION_ID,
        origin: "cli_hook",
        requestId: "req-1",
        toolName: "bash",
        toolCallId: "call-7",
        toolArgs: { command: "ls" },
      });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0].type).toBe("agent-permission-request");
      expect(dispatched[0].detail).toEqual({
        requestId: "req-1",
        sessionId: SESSION_ID,
        tool: "bash",
        toolCallId: "call-7",
        args: { command: "ls" },
        origin: "cli_hook",
      });
    });

    it("defaults the tool name and args when the frame omits them", () => {
      handler.handleEvent({
        type: "permission:request",
        session_id: SESSION_ID,
        origin: "acp",
        requestId: "req-2",
        toolArgs: "not-an-object",
      });

      expect(dispatched[0].detail).toMatchObject({
        tool: "unknown",
        args: {},
        origin: "acp",
      });
    });

    it("rejects permission frames from an unknown origin or without a requestId", () => {
      handler.handleEvent({
        type: "permission:request",
        session_id: SESSION_ID,
        origin: "someone_elses_transport",
        requestId: "req-3",
      });
      handler.handleEvent({
        type: "permission:request",
        session_id: SESSION_ID,
        origin: "cli_hook",
      });
      handler.handleEvent({
        type: "permission:request",
        session_id: SESSION_ID,
        origin: "cli_hook",
        requestId: "",
      });

      expect(dispatched).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Interactive-tool finalization
  // -------------------------------------------------------------------------

  describe("agent:interaction_finalized", () => {
    it("merges a tool_result keyed by the finalized tool call id", async () => {
      handler.handleEvent({
        type: "agent:interaction_finalized",
        session_id: SESSION_ID,
        toolCallId: "call-ask",
        tool: "ask_user_questions",
        resultPreview: "Answered",
        resultObject: { choice: "yes" },
      });
      await flush();

      expect(eventsFor()).toHaveLength(1);
      expect(eventsFor()[0]).toMatchObject({
        id: "tool-result-call-ask",
        callId: "call-ask",
        functionName: "ask_user_questions",
        actionType: "tool_result",
        displayStatus: "completed",
        result: {
          content: "Answered",
          observation: "Answered",
          choice: "yes",
        },
      });
    });

    it("refuses to synthesize an id when the finalize frame has no toolCallId", async () => {
      handler.handleEvent({
        type: "agent:interaction_finalized",
        session_id: SESSION_ID,
        tool: "ask_user_questions",
        resultPreview: "Answered",
      });
      await flush();

      expect(store.eventsBySession.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Session row mutations
  // -------------------------------------------------------------------------

  describe("worktree and merge frames", () => {
    // -----------------------------------------------------------------------
    // Both frames can arrive BEFORE the session row exists — exactly the state
    // these tests start from — so they take `upsertSession`'s INSERT path,
    // which stores whatever the caller passed (only the UPDATE path pins
    // timestamps to the prior row). They used to pass `created_at: ""` /
    // `updated_at: ""`, and `src/features/TaskKanban/hooks/useKanbanTasks/
    // taskTimestamps.ts` reads an empty timestamp as 0 — sorting the session
    // to the epoch and dropping it out of every 6h / 12h / 24h Kanban window.
    //
    // The timestamp assertions below are explicit because `toMatchObject`
    // silently skips fields it is not given.
    // -----------------------------------------------------------------------

    function onlySessionRow() {
      const sessions = getInstrumentedStore().get(sessionsAtom);
      expect(sessions).toHaveLength(1);
      return sessions[0];
    }

    function emitWorktreeCreated() {
      handler.handleEvent({
        type: "code_session.worktree_created",
        session_id: SESSION_ID,
        worktree_path: "/repo/.worktrees/wt-1",
        branch: "feat/wt-1",
        base_branch: "develop",
      });
    }

    function emitMergeResult() {
      handler.handleEvent({
        type: "code_session.merge_result",
        session_id: SESSION_ID,
        status: "merged",
      });
    }

    function expectFreshInsertTimestamps(
      session: ReturnType<typeof onlySessionRow>
    ) {
      const createdMs = Date.parse(session.created_at);
      const updatedMs = Date.parse(session.updated_at);
      expect(Number.isNaN(createdMs)).toBe(false);
      expect(Number.isNaN(updatedMs)).toBe(false);
      // "Now", not the epoch and not any other placeholder: the Kanban time
      // filters bucket on these, so anything stale hides the session.
      const ageMs = Date.now() - createdMs;
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThan(60_000);
      expect(session.updated_at).toBe(session.created_at);
    }

    it("writes worktree metadata onto the session row", () => {
      emitWorktreeCreated();

      const session = onlySessionRow();
      expect(session).toMatchObject({
        session_id: SESSION_ID,
        worktreePath: "/repo/.worktrees/wt-1",
        worktreeBranch: "feat/wt-1",
        baseBranch: "develop",
        mergeStatus: "pending",
        status: "pending",
      });
    });

    it("inserts real timestamps on a worktree_created frame", () => {
      emitWorktreeCreated();

      expectFreshInsertTimestamps(onlySessionRow());
    });

    it("records the merge status, and ignores a merge frame with no status", () => {
      handler.handleEvent({
        type: "code_session.merge_result",
        session_id: SESSION_ID,
      });
      expect(getInstrumentedStore().get(sessionsAtom)).toHaveLength(0);

      emitMergeResult();

      expect(onlySessionRow()).toMatchObject({
        session_id: SESSION_ID,
        mergeStatus: "merged",
        status: "completed",
      });
    });

    it("inserts real timestamps on a merge_result frame", () => {
      emitMergeResult();

      expectFreshInsertTimestamps(onlySessionRow());
    });

    it("leaves an existing row's timestamps alone (upsert update path)", () => {
      // The pinning that makes the insert-path defect survivable elsewhere:
      // when the row already exists, `upsertSession` refuses the caller's
      // empty strings. This is what keeps the bug from being universal, and
      // it must not regress while the insert path is being fixed.
      getInstrumentedStore().set(sessionsAtom, [
        {
          session_id: SESSION_ID,
          status: "running",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-08-01T01:00:00.000Z",
        },
      ]);

      emitWorktreeCreated();

      const session = onlySessionRow();
      expect(session.created_at).toBe("2026-08-01T00:00:00.000Z");
      expect(session.updated_at).toBe("2026-08-01T01:00:00.000Z");
      expect(session.worktreePath).toBe("/repo/.worktrees/wt-1");
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  describe("reset / dispose", () => {
    it("drops the live stream state so the next delta starts a new event", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "first turn", is_delta: true },
          })
        )
      );
      await flush();
      const firstId = String(eventsFor()[0].id);

      handler.reset();
      expect(handler.isStreaming).toBe(false);

      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "second turn", is_delta: true },
          })
        )
      );
      await flush();

      const streamIds = eventsFor()
        .map((event) => String(event.id))
        .filter((id) => id.startsWith("stream-msg-ts-"));
      expect(streamIds).toHaveLength(2);
      expect(streamIds[1]).not.toBe(firstId);
      expect(String(eventsFor()[1].displayText)).toBe("second turn");
    });

    it("dispose() leaves the handler in the same state as reset()", async () => {
      handler.handleEvent(
        activityEvent(
          makeChunk({
            action_type: "assistant_delta",
            result: { content: "x", is_delta: true },
          })
        )
      );
      await flush();
      expect(handler.isStreaming).toBe(true);

      handler.dispose();

      expect(handler.isStreaming).toBe(false);
      expect(store.streamingLog.at(-1)).toEqual({
        streaming: false,
        sessionId: SESSION_ID,
      });
    });
  });
});
