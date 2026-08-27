/**
 * Session-list status contract for `CliTurnLifecycleCoordinator`.
 *
 * `handleStatus` takes a raw wire string — it arrives from the `cli.statusBatch`
 * RPC and from run receipts — and, on a terminal, patches `Session.status`, the
 * field that drives sidebar grouping, Kanban lanes and every terminal-status
 * predicate. Nothing unvalidated may reach it.
 *
 * Kept apart from the sibling `cliTurnLifecycleCoordinator.test.ts` on purpose:
 * that file deliberately runs with an uninitialised Jotai store, so the
 * coordinator's `isStoreInitialized()` guards short-circuit and the
 * session-list destination is invisible there. Initialising the store is what
 * makes it observable, and it also switches on `markObservedCliTerminalStatus`,
 * hence the event-store mock below.
 *
 * `expectRowStatus` takes a `SessionStatus`, so every expectation below is
 * compiler-proved to be inside the union *and* runtime-proved to be what the
 * row holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetTurnLifecycleForTests } from "@src/engines/SessionCore/control/turnLifecycle";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { SessionStatus } from "@src/types/session/session";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { CliTurnLifecycleCoordinator } from "./cliTurnLifecycleCoordinator";

const SESSION_ID = "cliagent-list-status";

vi.mock("@src/engines/SessionCore/core/store/EventStoreProxy", () => ({
  eventStoreProxy: {
    getEvents: vi.fn(async () => []),
    upsert: vi.fn(async () => {}),
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

function rowStatus(): string | undefined {
  return getInstrumentedStore().get(sessionsAtom)[0]?.status;
}

function expectRowStatus(expected: SessionStatus): void {
  expect(rowStatus()).toBe(expected);
}

/**
 * Same proof, weaker claim: the row holds one of these `SessionStatus` values
 * and nothing else. Used where the terminal guard — not the narrowing — decides
 * whether the write happens at all, so the test stays true whichever way that
 * guard is set while still failing on anything outside the union.
 */
function expectRowStatusIn(...allowed: SessionStatus[]): void {
  expect(allowed).toContain(rowStatus());
}

describe("CliTurnLifecycleCoordinator session-list status", () => {
  beforeEach(() => {
    resetTurnLifecycleForTests();
    createInstrumentedStore();
    seedSessionRow();
  });

  it("never writes an unknown wire status into the session list", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());

    coordinator.handleStatus({
      sessionId: SESSION_ID,
      status: "quantum_superposition",
    });

    // Deliberately no assertion on the return value: whether the coordinator
    // applies the event is the terminal guard's business, and pinning it here
    // would mask the assertion that matters.
    //
    // Two ways this stays true, and the test does not care which:
    //   - today the status narrows to `idle`, which is neither `running` nor
    //     terminal, so the event is ignored and the row keeps `running`;
    //   - if `isCliTerminalStatus` ever admits it, the narrowing has already
    //     collapsed it to `idle` before the write.
    // What must never happen is the wire string itself landing in the row.
    expectRowStatusIn("running", "idle");
  });

  it("never writes the CLI-only 'installing' status into the session list", () => {
    // `installing` is a `CliSessionStatus` member with no `SessionStatus`
    // counterpart. It is not terminal, so it must not reach the row at all.
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());

    expect(
      coordinator.handleStatus({
        sessionId: SESSION_ID,
        status: "installing",
      })
    ).toBe(false);

    expectRowStatus("running");
  });

  it("writes a recognised terminal status through to the session list", () => {
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());

    expect(
      coordinator.handleStatus({
        sessionId: SESSION_ID,
        status: "completed",
      })
    ).toBe(true);

    expectRowStatus("completed");
  });

  it("writes the recovery-sweep 'abandoned' terminal through unchanged", () => {
    // Every member of the CLI terminal set is also a `SessionStatus`, so the
    // mapping must not flatten the rarer ones onto a fallback.
    const coordinator = new CliTurnLifecycleCoordinator(vi.fn());

    expect(
      coordinator.handleStatus({
        sessionId: SESSION_ID,
        status: "abandoned",
      })
    ).toBe(true);

    expectRowStatus("abandoned");
  });
});
