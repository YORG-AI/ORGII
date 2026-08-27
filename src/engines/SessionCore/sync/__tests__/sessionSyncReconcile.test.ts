/**
 * Reconciliation contract for in-flight history.
 *
 * `reconcileInFlightHistory` is the local-vs-remote arbiter: it re-reads the
 * adapter's persisted history on a retry ladder and decides whether the replay
 * merges next to what is on screen or replaces it wholesale. The two rules that
 * matter are (a) a stale session must never win, and (b) a native-transcript
 * session must never merge a replay next to live in-memory turn events.
 *
 * Only the timer (`waitForReconcileDelay`) and the Rust event store are mocked.
 * `sessionSyncUtils`' hydration helpers, `nativeTranscriptReconcile`'s registry,
 * the status narrowing and the Jotai session store all run for real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { ContextUsageSnapshot } from "@src/store/session/cliSessionStatusAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { CliSessionStatus } from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { registerSessionTranscriptSource } from "../nativeTranscriptReconcile";
import {
  applySwitchPostLoadResult,
  reconcileInFlightHistory,
} from "../sessionSyncReconcile";
import { IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS } from "../sessionSyncUtils";
import type { PostLoadResult, SessionAdapter } from "../types";

const SESSION_ID = "cliagent-reconcile";

// ---------------------------------------------------------------------------
// I/O + timer edges
// ---------------------------------------------------------------------------

const store = vi.hoisted(() => {
  const eventsBySession = new Map<string, unknown[]>();
  return {
    eventsBySession,
    reset() {
      eventsBySession.clear();
    },
    api: {
      set: vi.fn(async (events: unknown[], sessionId: string) => {
        eventsBySession.set(sessionId, [...events]);
      }),
      mergeEvents: vi.fn(async (events: unknown[], sessionId: string) => {
        const existing = eventsBySession.get(sessionId) ?? [];
        eventsBySession.set(sessionId, [...existing, ...events]);
      }),
      getEvents: vi.fn(
        async (sessionId: string) => eventsBySession.get(sessionId) ?? []
      ),
    },
  };
});

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: store.api,
}));

const timer = vi.hoisted(() => ({ delays: [] as number[] }));

vi.mock("../sessionSyncUtils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessionSyncUtils")>();
  return {
    ...actual,
    // Timer edge only — every other helper in this module stays real.
    waitForReconcileDelay: vi.fn(async (delayMs: number) => {
      timer.delays.push(delayMs);
    }),
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(id: string): SessionEvent {
  return {
    id,
    chunk_id: id,
    sessionId: SESSION_ID,
    createdAt: "2026-08-01T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: { observation: id },
    source: "assistant",
    displayText: id,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

interface RecordedActions {
  loads: Array<{
    sessionId: string;
    events: SessionEvent[];
    replace?: boolean;
  }>;
  contextTokens: number[];
  contextUsage: Array<ContextUsageSnapshot | null>;
  runtimeStatus: CliSessionStatus[];
  runtimeError: Array<string | null>;
}

function makeActions() {
  const recorded: RecordedActions = {
    loads: [],
    contextTokens: [],
    contextUsage: [],
    runtimeStatus: [],
    runtimeError: [],
  };
  return {
    recorded,
    actions: {
      dispatchLoadSession: (payload: {
        sessionId: string;
        events: SessionEvent[];
        replace?: boolean;
      }) => {
        recorded.loads.push(payload);
      },
      setSessionContextTokens: (value: number) => {
        recorded.contextTokens.push(value);
      },
      setSessionContextUsage: (value: ContextUsageSnapshot | null) => {
        recorded.contextUsage.push(value);
      },
      setSessionRuntimeStatus: (value: CliSessionStatus) => {
        recorded.runtimeStatus.push(value);
      },
      setSessionRuntimeError: (value: string | null) => {
        recorded.runtimeError.push(value);
      },
    },
  };
}

function makeAdapter(options: {
  history: SessionEvent[] | (() => SessionEvent[]);
  postLoad?: PostLoadResult | (() => PostLoadResult);
  category?: string;
  onLoadHistory?: () => void;
}): SessionAdapter & { loadHistoryCalls: number } {
  const adapter = {
    loadHistoryCalls: 0,
    category: options.category ?? "cli",
    loadHistory: vi.fn(async () => {
      adapter.loadHistoryCalls += 1;
      options.onLoadHistory?.();
      return typeof options.history === "function"
        ? options.history()
        : options.history;
    }),
    createEventHandler: vi.fn(),
    sendMessage: vi.fn(),
    stopSession: vi.fn(),
    ...(options.postLoad
      ? {
          postLoad: vi.fn(async () =>
            typeof options.postLoad === "function"
              ? options.postLoad()
              : (options.postLoad as PostLoadResult)
          ),
        }
      : {}),
  } as unknown as SessionAdapter & { loadHistoryCalls: number };
  return adapter;
}

function liveRefs(current: string | null = SESSION_ID) {
  return { liveSessionIdRef: { current } };
}

/** Lets the fire-and-forget reconcile loop run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("reconcileInFlightHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.reset();
    timer.delays.length = 0;
    createInstrumentedStore();
    getInstrumentedStore().set(sessionsAtom, []);
    // Default: not a native-transcript session.
    registerSessionTranscriptSource(SESSION_ID, "chunks");
  });

  it("merges the replay next to live events and stops on a terminal run status", async () => {
    const adapter = makeAdapter({
      history: [makeEvent("a"), makeEvent("b")],
      postLoad: { runStatus: "completed", contextTokens: 1234 },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(recorded.loads).toEqual([
      { sessionId: SESSION_ID, events: [makeEvent("a"), makeEvent("b")] },
    ]);
    expect(store.api.mergeEvents).toHaveBeenCalledTimes(1);
    expect(store.api.set).not.toHaveBeenCalled();
    expect(recorded.contextTokens).toEqual([1234]);
    expect(recorded.runtimeStatus).toEqual(["completed"]);
    // Terminal status ends the ladder after the first attempt.
    expect(adapter.loadHistoryCalls).toBe(1);
    expect(timer.delays).toEqual([0]);
  });

  it("walks the full retry ladder while the run status stays non-terminal", async () => {
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus: "running" },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(timer.delays).toEqual([...IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS]);
    expect(adapter.loadHistoryCalls).toBe(
      IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS.length
    );
    expect(recorded.loads).toHaveLength(
      IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS.length
    );
  });

  it("retries without dispatching while the adapter has no history yet", async () => {
    let attempts = 0;
    const adapter = makeAdapter({
      history: () => (attempts++ < 2 ? [] : [makeEvent("late")]),
      postLoad: { runStatus: "completed" },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    // The two empty reads `continue` past the post-load application entirely.
    expect(recorded.loads).toEqual([
      { sessionId: SESSION_ID, events: [makeEvent("late")] },
    ]);
    expect(recorded.runtimeStatus).toEqual(["completed"]);
    expect(adapter.loadHistoryCalls).toBe(3);
  });

  it("abandons the reconcile when the user switched away before postLoad", async () => {
    const refs = liveRefs();
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus: "running" },
    });
    const { recorded, actions } = makeActions();
    refs.liveSessionIdRef.current = "cliagent-elsewhere";

    reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
    await settle();

    expect(adapter.loadHistoryCalls).toBe(0);
    expect(recorded.loads).toEqual([]);
    expect(store.api.mergeEvents).not.toHaveBeenCalled();
  });

  it("abandons the reconcile when the user switches away mid-read", async () => {
    const refs = liveRefs();
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus: "running" },
      onLoadHistory: () => {
        refs.liveSessionIdRef.current = "cliagent-elsewhere";
      },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
    await settle();

    expect(adapter.loadHistoryCalls).toBe(1);
    expect(recorded.loads).toEqual([]);
    expect(store.api.mergeEvents).not.toHaveBeenCalled();
    expect(recorded.runtimeStatus).toEqual([]);
  });

  it("abandons the reconcile when postLoad resolves after the switch", async () => {
    const refs = liveRefs();
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: () => {
        refs.liveSessionIdRef.current = "cliagent-elsewhere";
        return { runStatus: "running" };
      },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
    await settle();

    expect(adapter.loadHistoryCalls).toBe(0);
    expect(recorded.loads).toEqual([]);
    expect(recorded.runtimeStatus).toEqual([]);
  });

  it("abandons the merge when the switch lands during hydration", async () => {
    const refs = liveRefs();
    store.api.mergeEvents.mockImplementationOnce(async () => {
      refs.liveSessionIdRef.current = "cliagent-elsewhere";
    });
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus: "running" },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
    await settle();

    expect(store.api.mergeEvents).toHaveBeenCalledTimes(1);
    expect(recorded.loads).toEqual([]);
    expect(recorded.runtimeStatus).toEqual([]);
  });

  it("narrows an unknown run status to idle before it reaches the runtime atom", async () => {
    // Renamed from "…instead of writing it verbatim": this test only observes
    // `setSessionRuntimeStatus`. The session-list write on the very next line
    // of the product is a separate destination — see the pair below.
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus: "quantum_superposition" },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(new Set(recorded.runtimeStatus)).toEqual(new Set(["idle"]));
    // Not terminal, so the ladder keeps retrying.
    expect(adapter.loadHistoryCalls).toBe(
      IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS.length
    );
  });

  // -------------------------------------------------------------------------
  // The narrowing has to cover BOTH destinations.
  //
  // `sessionSyncReconcile.ts` writes the run status twice, back to back: into
  // the runtime atom via `setSessionRuntimeStatus`, and into the session-list
  // cache via `updateSessionStatus`. It used to launder the raw, unvalidated
  // wire string through `as SessionStatus` on the second line, so every
  // consumer of `Session.status` (sidebar grouping, Kanban lanes, the
  // terminal-status predicates) could see a value outside the union.
  //
  // The tests above cannot see that destination because they seed
  // `sessionsAtom` with `[]` and `updateSessionStatus` only patches rows that
  // already exist. The tests below seed a row first.
  // -------------------------------------------------------------------------

  function seedSessionRow() {
    getInstrumentedStore().set(sessionsAtom, [
      {
        session_id: SESSION_ID,
        status: "running",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
  }

  function sessionRowStatuses() {
    return getInstrumentedStore()
      .get(sessionsAtom)
      .map((session) => session.status);
  }

  async function reconcileWithStatus(runStatus: string) {
    seedSessionRow();
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: { runStatus },
    });
    reconcileInFlightHistory(
      SESSION_ID,
      adapter,
      liveRefs(),
      makeActions().actions
    );
    await settle();
  }

  it("narrows an unknown run status before writing the session list cache", async () => {
    await reconcileWithStatus("quantum_superposition");

    expect(sessionRowStatuses()).toEqual(["idle"]);
  });

  it("passes a recognised run status through to the session list cache", async () => {
    // The narrowing must not flatten every value to the fallback — a real
    // status still has to land verbatim, or the sidebar/Kanban would show
    // every reconciled session as idle.
    await reconcileWithStatus("paused");

    expect(sessionRowStatuses()).toEqual(["paused"]);
  });

  it("maps the CLI-only 'installing' status onto the running lane", async () => {
    // `installing` is a `CliSessionStatus` member with no `SessionStatus`
    // counterpart. Both `RUNNING_SESSION_STATUSES` (TaskKanban/config.ts) and
    // `IN_PROGRESS_STATUSES` (util/session/sessionInProgress.ts) group it with
    // `running`, so collapsing it there preserves lane + spinner rather than
    // dropping the row into the fallback.
    await reconcileWithStatus("installing");

    expect(sessionRowStatuses()).toEqual(["running"]);
  });

  it("propagates context usage and the run error from postLoad", async () => {
    const usage: ContextUsageSnapshot = {
      usedTokens: 10,
      maxTokens: 100,
      percentUsed: 10,
      updatedAt: "2026-08-01T00:00:00.000Z",
      sections: [],
      warnings: [],
    } as unknown as ContextUsageSnapshot;
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: {
        contextTokens: 7,
        contextUsage: usage,
        runStatus: "failed",
        runError: "provider exploded",
      },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(recorded.contextTokens).toEqual([7]);
    expect(recorded.contextUsage).toEqual([usage]);
    expect(recorded.runtimeStatus).toEqual(["failed"]);
    // A terminal status returns before the run error is applied.
    expect(recorded.runtimeError).toEqual([]);
  });

  it("applies the run error when the status is still in flight", async () => {
    let attempts = 0;
    const adapter = makeAdapter({
      history: [makeEvent("a")],
      postLoad: () => {
        attempts += 1;
        return attempts === 1
          ? { runStatus: "running", runError: "transient hiccup" }
          : { runStatus: "completed" };
      },
    });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(recorded.runtimeError).toEqual(["transient hiccup"]);
    expect(recorded.runtimeStatus).toEqual(["running", "completed"]);
  });

  it("hydrates and dispatches even when the adapter has no postLoad", async () => {
    const adapter = makeAdapter({ history: [makeEvent("a")] });
    const { recorded, actions } = makeActions();

    reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
    await settle();

    expect(recorded.loads).toHaveLength(
      IN_FLIGHT_HISTORY_RECONCILE_DELAYS_MS.length
    );
    expect(recorded.runtimeStatus).toEqual([]);
    expect(recorded.contextTokens).toEqual([]);
  });

  describe("native-transcript sessions", () => {
    beforeEach(() => {
      registerSessionTranscriptSource(SESSION_ID, "native");
    });

    it("replaces the on-screen events only when the store is empty", async () => {
      const adapter = makeAdapter({
        history: [makeEvent("replayed")],
        postLoad: { runStatus: "completed" },
      });
      const { recorded, actions } = makeActions();

      reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
      await settle();

      expect(store.api.set).toHaveBeenCalledTimes(1);
      expect(store.api.mergeEvents).not.toHaveBeenCalled();
      expect(recorded.loads).toEqual([
        {
          sessionId: SESSION_ID,
          events: [makeEvent("replayed")],
          replace: true,
        },
      ]);
    });

    it("never merges a replay next to live in-memory turn events", async () => {
      store.eventsBySession.set(SESSION_ID, [makeEvent("live-bubble")]);
      const adapter = makeAdapter({
        history: [makeEvent("replayed")],
        postLoad: { runStatus: "completed", contextTokens: 55 },
      });
      const { recorded, actions } = makeActions();

      reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
      await settle();

      expect(recorded.loads).toEqual([]);
      expect(store.api.set).not.toHaveBeenCalled();
      expect(store.api.mergeEvents).not.toHaveBeenCalled();
      // The post-load metadata still lands — only the replay is suppressed.
      expect(recorded.contextTokens).toEqual([55]);
      expect(recorded.runtimeStatus).toEqual(["completed"]);
    });

    it("is idempotent across retries: a second tick re-replaces, never appends", async () => {
      const adapter = makeAdapter({
        history: [makeEvent("replayed")],
        postLoad: { runStatus: "running" },
        // Emulate the real store: the `set` above leaves events behind, so
        // every later tick must take the "store not empty" branch.
      });
      const { recorded, actions } = makeActions();

      reconcileInFlightHistory(SESSION_ID, adapter, liveRefs(), actions);
      await settle();

      expect(store.api.set).toHaveBeenCalledTimes(1);
      expect(recorded.loads).toHaveLength(1);
      expect(recorded.loads[0].replace).toBe(true);
    });

    it("drops the replace-dispatch when the switch lands during hydration", async () => {
      const refs = liveRefs();
      store.api.set.mockImplementationOnce(async () => {
        refs.liveSessionIdRef.current = "cliagent-elsewhere";
      });
      const adapter = makeAdapter({
        history: [makeEvent("replayed")],
        postLoad: { runStatus: "running" },
      });
      const { recorded, actions } = makeActions();

      reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
      await settle();

      expect(store.api.set).toHaveBeenCalledTimes(1);
      expect(recorded.loads).toEqual([]);
      expect(recorded.runtimeStatus).toEqual([]);
    });

    it("drops a replay when the session is switched away between read and hydrate", async () => {
      const refs = liveRefs();
      store.api.getEvents.mockImplementationOnce(async () => {
        refs.liveSessionIdRef.current = "cliagent-elsewhere";
        return [];
      });
      const adapter = makeAdapter({
        history: [makeEvent("replayed")],
        postLoad: { runStatus: "running" },
      });
      const { recorded, actions } = makeActions();

      reconcileInFlightHistory(SESSION_ID, adapter, refs, actions);
      await settle();

      expect(store.api.set).not.toHaveBeenCalled();
      expect(recorded.loads).toEqual([]);
    });
  });
});

describe("applySwitchPostLoadResult", () => {
  beforeEach(() => {
    createInstrumentedStore();
    getInstrumentedStore().set(sessionsAtom, []);
  });

  it("is a no-op for a null post-load result", () => {
    const { recorded, actions } = makeActions();

    applySwitchPostLoadResult(SESSION_ID, null, actions);

    expect(recorded).toMatchObject({
      contextTokens: [],
      runtimeStatus: [],
      runtimeError: [],
    });
  });

  it("narrows the run status and mirrors the error", () => {
    const { recorded, actions } = makeActions();

    applySwitchPostLoadResult(
      SESSION_ID,
      { contextTokens: 3, runStatus: "not_a_status", runError: null },
      actions
    );

    expect(recorded.contextTokens).toEqual([3]);
    expect(recorded.runtimeStatus).toEqual(["idle"]);
    expect(recorded.runtimeError).toEqual([null]);
  });
});
