/**
 * Session atom derived values and helpers — pure logic tests.
 *
 * Tests the pure helpers (`isValidSessionUUID`, `sessionByIdAtom` cache),
 * and derived atoms (`sessionsAtom`, `sessionMapAtom`, `validSessionIdsAtom`,
 * session count atoms) using a raw Jotai store to avoid React/hook machinery.
 */
import { createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import {
  anySessionWorkingAtom,
  recentSessionsAtom,
  sessionActiveCountAtom,
  sessionByIdAtom,
  sessionCompletedCountAtom,
  sessionMapAtom,
  sessionTotalCountAtom,
  sessionsAtom,
  validSessionIdsAtom,
} from "../sessionAtom/atoms";
import { isValidSessionUUID } from "../sessionAtom/helpers";
import type { Session } from "../sessionAtom/types";

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: vi.fn(() => createStore()),
}));

vi.mock("../sessionAtom/persistence", () => ({
  loadPersistedSessions: vi.fn(() => []),
}));

function makeSession(
  overrides: Partial<Session> & { session_id: string }
): Session {
  return {
    status: "completed",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeStore(sessions: Session[] = []) {
  const store = createStore();
  store.set(sessionsAtom, sessions);
  return store;
}

describe("isValidSessionUUID", () => {
  it("accepts a valid v4 UUID", () => {
    expect(isValidSessionUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(
      true
    );
    expect(isValidSessionUUID("550e8400-e29b-4d34-a716-446655440000")).toBe(
      true
    );
  });

  it("rejects empty string", () => {
    expect(isValidSessionUUID("")).toBe(false);
  });

  it("rejects malformed IDs", () => {
    expect(isValidSessionUUID("not-a-uuid")).toBe(false);
    expect(isValidSessionUUID("1234-5678")).toBe(false);
    // v1 UUID (version bit = 1) rejected by v4 regex
    expect(isValidSessionUUID("550e8400-e29b-1d34-a716-446655440000")).toBe(
      false
    );
  });
});

describe("sessionMapAtom", () => {
  it("is empty with no sessions", () => {
    const store = makeStore();
    expect(store.get(sessionMapAtom).size).toBe(0);
  });

  it("keys sessions by session_id", () => {
    const s = makeSession({ session_id: "abc-123" });
    const store = makeStore([s]);
    const map = store.get(sessionMapAtom);
    expect(map.size).toBe(1);
    expect(map.get("abc-123")).toBe(s);
  });

  it("returns the same reference when sessions array is unchanged", () => {
    const s = makeSession({ session_id: "abc" });
    const store = makeStore([s]);
    const first = store.get(sessionMapAtom);
    const second = store.get(sessionMapAtom);
    expect(first).toBe(second);
  });
});

describe("validSessionIdsAtom", () => {
  it("contains all session IDs", () => {
    const sessions = [
      makeSession({ session_id: "a" }),
      makeSession({ session_id: "b" }),
    ];
    const store = makeStore(sessions);
    const ids = store.get(validSessionIdsAtom);
    expect(ids.has("a")).toBe(true);
    expect(ids.has("b")).toBe(true);
  });

  it("is empty when there are no sessions", () => {
    expect(makeStore().get(validSessionIdsAtom).size).toBe(0);
  });
});

describe("count atoms", () => {
  it("sessionTotalCountAtom reflects array length", () => {
    const store = makeStore([
      makeSession({ session_id: "a" }),
      makeSession({ session_id: "b" }),
    ]);
    expect(store.get(sessionTotalCountAtom)).toBe(2);
  });

  it("sessionActiveCountAtom counts running sessions", () => {
    const store = makeStore([
      makeSession({ session_id: "r1", status: "running" }),
      makeSession({ session_id: "r2", status: "idle" }),
      makeSession({ session_id: "r3", status: "completed" }),
    ]);
    expect(store.get(sessionActiveCountAtom)).toBe(2);
  });

  it("sessionCompletedCountAtom counts only completed", () => {
    const store = makeStore([
      makeSession({ session_id: "c1", status: "completed" }),
      makeSession({ session_id: "c2", status: "completed" }),
      makeSession({ session_id: "r1", status: "running" }),
    ]);
    expect(store.get(sessionCompletedCountAtom)).toBe(2);
  });
});

describe("anySessionWorkingAtom", () => {
  it("is false when all sessions are completed", () => {
    const store = makeStore([
      makeSession({ session_id: "a", status: "completed" }),
    ]);
    expect(store.get(anySessionWorkingAtom)).toBe(false);
  });

  it("is true when a session is running", () => {
    const store = makeStore([
      makeSession({ session_id: "a", status: "running" }),
    ]);
    expect(store.get(anySessionWorkingAtom)).toBe(true);
  });

  it("is true when a session is in_progress", () => {
    const store = makeStore([
      makeSession({ session_id: "a", status: "in_progress" }),
    ]);
    expect(store.get(anySessionWorkingAtom)).toBe(true);
  });
});

describe("recentSessionsAtom", () => {
  it("returns at most 10 sessions", () => {
    const sessions = Array.from({ length: 15 }, (_, idx) =>
      makeSession({ session_id: `s${idx}` })
    );
    const store = makeStore(sessions);
    expect(store.get(recentSessionsAtom)).toHaveLength(10);
  });

  it("returns all sessions when fewer than 10", () => {
    const sessions = [
      makeSession({ session_id: "a" }),
      makeSession({ session_id: "b" }),
    ];
    const store = makeStore(sessions);
    expect(store.get(recentSessionsAtom)).toHaveLength(2);
  });
});

describe("sessionByIdAtom", () => {
  it("resolves the correct session by ID", () => {
    const s = makeSession({ session_id: "target-id" });
    const store = makeStore([s, makeSession({ session_id: "other-id" })]);
    expect(store.get(sessionByIdAtom("target-id"))).toBe(s);
  });

  it("returns undefined for an unknown ID", () => {
    const store = makeStore([makeSession({ session_id: "known" })]);
    expect(store.get(sessionByIdAtom("unknown"))).toBeUndefined();
  });

  it("returns stable atom instances for the same ID", () => {
    expect(sessionByIdAtom("foo")).toBe(sessionByIdAtom("foo"));
  });

  it("preserves a live atom identity beyond the strong-cache limit", () => {
    const retained = sessionByIdAtom("retained-session");

    for (let index = 0; index < 600; index += 1) {
      sessionByIdAtom(`cache-pressure-${index}`);
    }

    expect(sessionByIdAtom("retained-session")).toBe(retained);
  });
});
