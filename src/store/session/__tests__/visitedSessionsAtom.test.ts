import { beforeEach, describe, expect, it, vi } from "vitest";

interface MemoryStorage extends Storage {
  failWrites: boolean;
  values: Map<string, string>;
}

function installStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial));
  const storage = {
    values,
    failWrites: false,
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      if (storage.failWrites) {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, String(value));
    },
  } as MemoryStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return storage;
}

beforeEach(() => {
  installStorage();
  vi.resetModules();
});

async function loadVisitedSessions() {
  const instrumentedStoreModule =
    await import("@src/util/core/state/instrumentedStore");
  const store = instrumentedStoreModule.createInstrumentedStore();
  const visitedModule = await import("../visitedSessionsAtom");
  return { store, ...visitedModule };
}

describe("visited session persistence", () => {
  it("keeps navigation state in memory when persistence exceeds quota", async () => {
    const storage = installStorage({
      "orgii:org2-cloud-v1:auth": "protected-auth",
    });
    storage.failWrites = true;
    const { store, markSessionVisited, visitedSessionIdsAtom } =
      await loadVisitedSessions();

    expect(() => markSessionVisited("session-1")).not.toThrow();
    expect(store.get(visitedSessionIdsAtom)).toEqual(["session-1"]);
    expect(storage.getItem("orgii:org2-cloud-v1:auth")).toBe("protected-auth");
  });

  it("bounds and deduplicates an oversized hydrated list", async () => {
    const sessionIds = Array.from(
      { length: 5_100 },
      (_, index) => `session-${index}`
    );
    sessionIds.splice(10, 0, "session-0");
    const storage = installStorage({
      "orgii:visited-sessions": JSON.stringify(sessionIds),
    });
    const { store, visitedSessionIdsAtom, __VISITED_SESSIONS_INTERNALS } =
      await loadVisitedSessions();

    const hydrated = store.get(visitedSessionIdsAtom);
    expect(hydrated).toHaveLength(__VISITED_SESSIONS_INTERNALS.MAX_VISITED_IDS);
    expect(new Set(hydrated).size).toBe(hydrated.length);
    expect(storage.getItem("orgii:visited-sessions")).not.toBeNull();
  });
});
