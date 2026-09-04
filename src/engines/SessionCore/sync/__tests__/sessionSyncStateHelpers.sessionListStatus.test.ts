/**
 * Session-list status contract for `sessionSyncStateHelpers`.
 *
 * Both writers in this module patch `Session.status` — the field that drives
 * sidebar grouping, Kanban lanes and every terminal-status predicate. Neither
 * may launder an unvalidated wire string into it.
 *
 * The sibling `sessionSyncStateHelpers.test.ts` mocks `@src/store/session`
 * wholesale, so it cannot see that destination at all. This file seeds a real
 * row in `sessionsAtom` and asserts what actually lands there. Only the Rust
 * event store is mocked; the narrowing, the turn lifecycle and the Jotai
 * session store all run for real.
 *
 * `expectRowStatus` takes a `SessionStatus`, so every expectation below is
 * compiler-proved to be inside the union *and* runtime-proved to be what the
 * row holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTurnLifecycleForTests } from "@src/engines/SessionCore/control/turnLifecycle";
import type {
  ContextBreakdown,
  ContextUsageSnapshot,
} from "@src/store/session/cliSessionStatusAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type {
  CliSessionStatus,
  SessionStatus,
} from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  applyPostLoadResult,
  createSessionEventHandlerCallbacks,
} from "../sessionSyncStateHelpers";
import type { SessionEventHandlerStateActions } from "../sessionSyncStateHelpers";

const SESSION_ID = "cliagent-state-helpers";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    pinSession: vi.fn(),
    unpinSession: vi.fn(),
  },
}));

function seedSessionRow(): void {
  getInstrumentedStore().set(sessionsAtom, [
    {
      session_id: SESSION_ID,
      status: "running",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    },
  ]);
}

function sessionRowStatuses(): Array<string | undefined> {
  return getInstrumentedStore()
    .get(sessionsAtom)
    .map((session) => session.status);
}

/**
 * The parameter is typed `SessionStatus`, so a value outside the union cannot
 * even be written as an expectation here — the assertion is a union-membership
 * proof, not just an equality check.
 */
function expectRowStatus(expected: SessionStatus): void {
  expect(sessionRowStatuses()).toEqual([expected]);
}

/**
 * Same proof, weaker claim: the row holds one of these `SessionStatus` values
 * and nothing else. Used where an upstream guard — not the narrowing — decides
 * whether the write happens at all, so the test stays true whichever way that
 * guard is set while still failing on anything outside the union.
 */
function expectRowStatusIn(...allowed: SessionStatus[]): void {
  expect(allowed).toContain(sessionRowStatuses()[0]);
}

function makePostLoadActions() {
  const runtimeStatus: CliSessionStatus[] = [];
  return {
    runtimeStatus,
    actions: {
      setSessionContextTokens: vi.fn(),
      setSessionContextUsage: vi.fn(),
      setSessionRuntimeStatus: (value: CliSessionStatus) => {
        runtimeStatus.push(value);
      },
      setSessionRuntimeError: vi.fn(),
    },
  };
}

function makeHandlerActions(): SessionEventHandlerStateActions & {
  runtimeStatus: CliSessionStatus[];
} {
  const runtimeStatus: CliSessionStatus[] = [];
  return {
    runtimeStatus,
    setSessionContextTokens: vi.fn(),
    setSessionContextUsage: vi.fn((_value: ContextUsageSnapshot | null) => {}),
    setSessionContextBreakdown: vi.fn((_value: ContextBreakdown | null) => {}),
    setSessionRuntimeStatus: (value: CliSessionStatus) => {
      runtimeStatus.push(value);
    },
    setSessionRuntimeError: vi.fn(),
    setPendingCancel: vi.fn(),
    setSessionRolledBack: vi.fn(),
    setStreamingDeltaContent: vi.fn(),
    dismissCanvasAtNewTurn: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetTurnLifecycleForTests();
  createInstrumentedStore();
  seedSessionRow();
});

// ---------------------------------------------------------------------------
// applyPostLoadResult — `PostLoadResult.runStatus` is a raw wire string
// (typed `string`) and reaches the session list on every session load. It is
// NOT gated by anything: a value the backend never should have emitted, and
// the CLI-only `installing`, both used to land verbatim in `Session.status`.
// ---------------------------------------------------------------------------

describe("applyPostLoadResult writes a validated status to the session list", () => {
  it("narrows an unknown run status before it reaches the session list cache", () => {
    const { actions, runtimeStatus } = makePostLoadActions();

    applyPostLoadResult(
      SESSION_ID,
      { runStatus: "quantum_superposition" },
      actions
    );

    expectRowStatus("idle");
    // The runtime atom and the list row must agree — one narrowing, two
    // destinations, not a narrowed value next to a laundered cast.
    expect(runtimeStatus).toEqual(["idle"]);
  });

  it("maps the CLI-only 'installing' status onto the running lane", () => {
    // `installing` is a `CliSessionStatus` member with no `SessionStatus`
    // counterpart, so the old cast put an out-of-union value in the row.
    // `RUNNING_SESSION_STATUSES` (features/TaskKanban/config.ts) and
    // `IN_PROGRESS_STATUSES` (util/session/sessionInProgress.ts) both group it
    // with `running`, so the row keeps its lane and its spinner.
    const { actions, runtimeStatus } = makePostLoadActions();

    applyPostLoadResult(SESSION_ID, { runStatus: "installing" }, actions);

    expectRowStatus("running");
    // The runtime atom keeps the finer-grained CLI value.
    expect(runtimeStatus).toEqual(["installing"]);
  });

  it("passes a recognised run status through unchanged", () => {
    // The narrowing must not flatten every value to the fallback, or every
    // loaded session would show as idle in the sidebar and on the board.
    const { actions } = makePostLoadActions();

    applyPostLoadResult(SESSION_ID, { runStatus: "paused" }, actions);

    expectRowStatus("paused");
  });

  it("passes a terminal run status through unchanged", () => {
    const { actions } = makePostLoadActions();

    applyPostLoadResult(SESSION_ID, { runStatus: "cancelled" }, actions);

    expectRowStatus("cancelled");
  });
});

// ---------------------------------------------------------------------------
// createSessionEventHandlerCallbacks().onStatusChange — the session-list write
// sits behind `TERMINAL_HANDLER_STATUSES.has(status)`, so today only
// completed/failed/cancelled can reach it. That Set is the ONLY thing standing
// between the wire string and `Session.status`; these tests pin both halves of
// the invariant so widening the Set later cannot silently reopen the hole.
// ---------------------------------------------------------------------------

describe("onStatusChange writes a validated status to the session list", () => {
  it("never writes an unknown wire status into the session list", () => {
    const actions = makeHandlerActions();
    const callbacks = createSessionEventHandlerCallbacks(
      SESSION_ID,
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("quantum_superposition");

    // Two ways this stays true, and the test does not care which:
    //   - today `TERMINAL_HANDLER_STATUSES` rejects it, so no session-list
    //     write happens and the row keeps `running`;
    //   - if that Set is ever widened, the narrowing collapses the unknown
    //     value to `idle` before it is written.
    // What must never happen is the wire string itself landing in the row.
    expectRowStatusIn("running", "idle");
    // The runtime mirror gets the narrowed fallback rather than the raw string.
    expect(actions.runtimeStatus).toEqual(["idle"]);
  });

  it("writes a terminal status through to the session list", () => {
    const actions = makeHandlerActions();
    const callbacks = createSessionEventHandlerCallbacks(
      SESSION_ID,
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("completed");

    expectRowStatus("completed");
    expect(actions.runtimeStatus).toEqual(["completed"]);
  });

  it("ignores an intermediate signal instead of writing the session list", () => {
    const actions = makeHandlerActions();
    const callbacks = createSessionEventHandlerCallbacks(
      SESSION_ID,
      actions,
      vi.fn()
    );

    callbacks.onStatusChange?.("completed", undefined, { intermediate: true });

    expectRowStatus("running");
  });
});
