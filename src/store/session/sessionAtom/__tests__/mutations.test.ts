/**
 * Mutation invariants for the session store.
 *
 * Backend-owned fields (`created_at`, `updated_at`, and their `*_time`
 * aliases) MUST NOT drift through frontend-only writes. These tests
 * lock that contract for the mutation entry points:
 *
 *   - `upsertSession` (insert + update)
 *   - `updateSessionStatus`
 *   - `applyImportedSessionTimestamps` — the one sanctioned override,
 *     narrowed to imported replay copies whose clock is the source's
 *
 * They are paranoid by design: the regression they protect against
 * (clicking an old session in WorkStation makes it appear in the 6h
 * Kanban window) was a one-line slip and easy to reintroduce.
 */
import { beforeEach, describe, expect, it } from "vitest";

import * as streamHelpers from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/streamHelpers";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import * as atoms from "../atoms";
import * as mutations from "../mutations";
import { sessionPaginationAtom } from "../paginationAtoms";
import { createSidebarRosterMatcher } from "../sidebarRoster";
import type { Session } from "../types";

// A fresh store per test is the whole isolation requirement here: atom values
// live in the store, so dropping it resets every atom. `vi.resetModules()` plus
// a dynamic re-import of the atom graph would do the same thing at ~10x the
// cost, once per test.
beforeEach(() => {
  resetInstrumentedStore();
  createInstrumentedStore();
});

async function loadModule() {
  return {
    upsertSession: mutations.upsertSession,
    updateSessionStatus: mutations.updateSessionStatus,
    applyImportedSessionTimestamps: mutations.applyImportedSessionTimestamps,
    sessionsAtom: atoms.sessionsAtom,
    sessionPaginationAtom,
    store: getInstrumentedStore(),
  };
}

const IMPORTED_FROM = {
  orgId: "org-1",
  sourceSessionId: "remote-1",
  ownerMemberId: "m2",
  ownerDisplayName: "Bob",
  epoch: 1,
  seq: 1,
  count: 1,
  frozenCount: 1,
  importedAt: "2026-07-20T12:00:00.000Z",
} as const;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    session_id: "sess-1",
    status: "running",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    created_time: "2026-01-01T00:00:00.000Z",
    updated_time: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("upsertSession", () => {
  it("inserts a brand-new session verbatim (timestamps from backend)", async () => {
    const { upsertSession, sessionsAtom, store } = await loadModule();
    const fresh = makeSession({
      session_id: "new-1",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
    });
    upsertSession(fresh);
    const sessions = store.get(sessionsAtom);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      session_id: "new-1",
      created_at: "2026-05-01T10:00:00.000Z",
      updated_at: "2026-05-01T10:00:00.000Z",
    });
  });

  it("registers a new primary native session in an authoritative sidebar roster", async () => {
    const { upsertSession, sessionPaginationAtom, store } = await loadModule();
    const pagination = store.get(sessionPaginationAtom);
    store.set(sessionPaginationAtom, {
      ...pagination,
      standalone_agent: {
        ...pagination.standalone_agent,
        sessionIds: ["existing-session"],
        cursor: {
          updatedAt: "2026-01-01T00:00:00.000Z",
          sessionId: "existing-session",
        },
        phase: "ready",
        generation: 1,
      },
    });

    const created = makeSession({
      session_id: "created-session",
      created_at: "2026-01-02T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    upsertSession(created);

    expect(
      store.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(["created-session", "existing-session"]);
    expect(
      createSidebarRosterMatcher(store.get(sessionPaginationAtom))(created)
    ).toBe(true);
  });

  it("does not register child sessions in the primary sidebar roster", async () => {
    const { upsertSession, sessionPaginationAtom, store } = await loadModule();
    const pagination = store.get(sessionPaginationAtom);
    store.set(sessionPaginationAtom, {
      ...pagination,
      standalone_agent: {
        ...pagination.standalone_agent,
        sessionIds: ["existing-session"],
        cursor: {
          updatedAt: "2026-01-01T00:00:00.000Z",
          sessionId: "existing-session",
        },
        phase: "ready",
        generation: 1,
      },
    });

    upsertSession(
      makeSession({
        session_id: "parent:subagent:child",
        parentSessionId: "parent",
      })
    );

    expect(
      store.get(sessionPaginationAtom).standalone_agent.sessionIds
    ).toEqual(["existing-session"]);
  });

  it("preserves prior updated_at on update even if caller spreads a fresh one", async () => {
    const { upsertSession, sessionsAtom, store } = await loadModule();
    const original = makeSession({
      updated_at: "2026-01-02T00:00:00.000Z",
    });
    upsertSession(original);

    // Simulate a careless local reconciliation that synthesizes "now".
    upsertSession({
      ...original,
      status: "completed",
      updated_at: new Date().toISOString(),
      updated_time: new Date().toISOString(),
    });

    const after = store.get(sessionsAtom)[0];
    expect(after.status).toBe("completed");
    expect(after.updated_at).toBe("2026-01-02T00:00:00.000Z");
    expect(after.updated_time).toBe("2026-01-02T00:00:00.000Z");
  });

  it("preserves prior created_at on update", async () => {
    const { upsertSession, sessionsAtom, store } = await loadModule();
    upsertSession(makeSession({ created_at: "2026-01-01T00:00:00.000Z" }));

    upsertSession(
      makeSession({
        name: "renamed",
        created_at: "2099-12-31T23:59:59.000Z",
      })
    );

    const after = store.get(sessionsAtom)[0];
    expect(after.name).toBe("renamed");
    expect(after.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("merges non-timestamp fields normally", async () => {
    const { upsertSession, sessionsAtom, store } = await loadModule();
    upsertSession(makeSession({ name: "before", model: "claude-opus" }));
    upsertSession(makeSession({ name: "after" }));
    const after = store.get(sessionsAtom)[0];
    expect(after.name).toBe("after");
    // Spread preserves untouched fields.
    expect(after.model).toBe("claude-opus");
  });
});

describe("applyImportedSessionTimestamps", () => {
  const SOURCE_TIMES = {
    created_at: "2026-06-01T09:30:00.000Z",
    updated_at: "2026-06-01T09:30:00.000Z",
    completed_at: "2026-06-01T09:30:00.000Z",
  };

  it("overrides the pinned timestamps on an imported replay copy", async () => {
    const {
      upsertSession,
      applyImportedSessionTimestamps,
      sessionsAtom,
      store,
    } = await loadModule();
    // The pre-fix state: the copy carries the moment the viewer clicked it.
    upsertSession(
      makeSession({
        session_id: "imported-1",
        created_at: "2026-07-20T12:00:00.000Z",
        updated_at: "2026-07-20T12:00:00.000Z",
        completed_at: "2026-07-20T12:00:00.000Z",
        importedFrom: IMPORTED_FROM,
      })
    );

    applyImportedSessionTimestamps("imported-1", SOURCE_TIMES);

    expect(store.get(sessionsAtom)[0]).toMatchObject(SOURCE_TIMES);
  });

  it("leaves a locally-owned session's timestamps pinned", async () => {
    const {
      upsertSession,
      applyImportedSessionTimestamps,
      sessionsAtom,
      store,
    } = await loadModule();
    upsertSession(makeSession({ session_id: "local-1" }));

    applyImportedSessionTimestamps("local-1", SOURCE_TIMES);

    const after = store.get(sessionsAtom)[0];
    expect(after.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(after.updated_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns the same array when nothing changes", async () => {
    const {
      upsertSession,
      applyImportedSessionTimestamps,
      sessionsAtom,
      store,
    } = await loadModule();
    upsertSession(
      makeSession({
        session_id: "imported-1",
        ...SOURCE_TIMES,
        importedFrom: IMPORTED_FROM,
      })
    );
    const before = store.get(sessionsAtom);

    applyImportedSessionTimestamps("imported-1", SOURCE_TIMES);

    expect(store.get(sessionsAtom)).toBe(before);
  });
});

describe("updateSessionStatus", () => {
  it("flips status without touching updated_at", async () => {
    const { upsertSession, updateSessionStatus, sessionsAtom, store } =
      await loadModule();
    upsertSession(
      makeSession({
        status: "running",
        updated_at: "2026-01-02T00:00:00.000Z",
      })
    );

    updateSessionStatus("sess-1", "completed");

    const after = store.get(sessionsAtom)[0];
    expect(after.status).toBe("completed");
    expect(after.updated_at).toBe("2026-01-02T00:00:00.000Z");
  });

  it("is a no-op for unknown session ids", async () => {
    const { upsertSession, updateSessionStatus, sessionsAtom, store } =
      await loadModule();
    upsertSession(makeSession());
    const before = store.get(sessionsAtom);
    updateSessionStatus("does-not-exist", "completed");
    const after = store.get(sessionsAtom);
    expect(after).toEqual(before);
  });
});

describe("removeSession", () => {
  it("drops the session and disposes its rust-agent streaming state", async () => {
    const { upsertSession, sessionsAtom, store } = await loadModule();

    upsertSession(makeSession({ session_id: "sess-x" }));

    // Seed per-turn streaming-stop state that only the deletion path can free.
    streamHelpers.noteSessionStreamingTurn("sess-x", "turn-1");
    streamHelpers.markSessionStreamingStopped("sess-x");
    expect(streamHelpers.isSessionStreamingStopped("sess-x", "turn-1")).toBe(
      true
    );

    mutations.removeSession("sess-x");

    // The single store chokepoint covers every deletion path (sidebar, cloud,
    // fork rollback, guest share) — the streaming state must be gone too.
    expect(store.get(sessionsAtom)).toHaveLength(0);
    expect(streamHelpers.isSessionStreamingStopped("sess-x", "turn-1")).toBe(
      false
    );
  });
});
