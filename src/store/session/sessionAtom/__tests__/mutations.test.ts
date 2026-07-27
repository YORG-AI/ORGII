/**
 * Mutation invariants for the session store.
 *
 * Backend-owned fields (`created_at`, `updated_at`, and their `*_time`
 * aliases) MUST NOT drift through frontend-only writes. These tests
 * lock that contract for the two mutation entry points:
 *
 *   - `upsertSession` (insert + update)
 *   - `updateSessionStatus`
 *
 * They are paranoid by design: the regression they protect against
 * (clicking an old session in WorkStation makes it appear in the 6h
 * Kanban window) was a one-line slip and easy to reintroduce.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../types";

beforeEach(() => {
  vi.resetModules();
});

async function loadModule() {
  const { createInstrumentedStore } =
    await import("@src/util/core/state/instrumentedStore");
  createInstrumentedStore();
  const mutations = await import("../mutations");
  const atoms = await import("../atoms");
  const { getInstrumentedStore } =
    await import("@src/util/core/state/instrumentedStore");
  return {
    upsertSession: mutations.upsertSession,
    updateSessionStatus: mutations.updateSessionStatus,
    sessionsAtom: atoms.sessionsAtom,
    store: getInstrumentedStore(),
  };
}

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
    const mutations = await import("../mutations");
    const streamHelpers =
      await import("@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/streamHelpers");

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
