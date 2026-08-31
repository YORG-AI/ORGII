/**
 * Unit tests for `cleanupInvalidUUIDStorage` / `deferredCleanup`.
 *
 * `cleanup.ts` deletes user data, so the assertions here are weighted toward
 * what must SURVIVE a cleanup pass rather than what gets removed. Every test
 * that removes something also snapshots the whole store to prove nothing else
 * moved.
 *
 * `cleanup.ts` calls `deferredCleanup()` at module scope, so the module is
 * imported dynamically under fake timers — otherwise the import-time timer
 * fires mid-suite and mutates the storage a later test is asserting on.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { REPO_STORAGE_KEYS } from "@src/store/repo";

// Two real v4 UUIDs — `isValidUUID` enforces version 1-5 and the 8/9/a/b variant.
const REPO_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REPO_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

const GIT_CACHE_PREFIX = "orgii_git_status_cache_";

type FailureRule = ((key: string) => boolean) | null;

function createStorageMock() {
  const entries = new Map<string, string>();
  let removeFailsFor: FailureRule = null;
  let getFailsFor: FailureRule = null;

  const api: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => {
      if (getFailsFor?.(key)) throw new Error(`getItem blocked: ${key}`);
      return entries.has(key) ? (entries.get(key) as string) : null;
    },
    key: (index: number) => Array.from(entries.keys())[index] ?? null,
    removeItem: (key: string) => {
      if (removeFailsFor?.(key)) throw new Error(`removeItem blocked: ${key}`);
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };

  return {
    api,
    seed(seedEntries: Record<string, string>) {
      entries.clear();
      removeFailsFor = null;
      getFailsFor = null;
      for (const [key, value] of Object.entries(seedEntries)) {
        entries.set(key, value);
      }
    },
    snapshot(): Record<string, string> {
      return Object.fromEntries(entries);
    },
    failRemoveFor(rule: FailureRule) {
      removeFailsFor = rule;
    },
    failGetFor(rule: FailureRule) {
      getFailsFor = rule;
    },
  };
}

const local = createStorageMock();
const session = createStorageMock();

Object.defineProperty(globalThis, "localStorage", {
  value: local.api,
  configurable: true,
});
Object.defineProperty(globalThis, "sessionStorage", {
  value: session.api,
  configurable: true,
});

let cleanupModule: typeof import("./cleanup");

beforeAll(async () => {
  // Fake timers swallow the `deferredCleanup()` that module evaluation
  // schedules; `clearAllTimers` then discards it so it never fires later.
  vi.useFakeTimers();
  cleanupModule = await import("./cleanup");
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  local.seed({});
  session.seed({});
});

describe("cleanupInvalidUUIDStorage — keys that must survive", () => {
  it("keeps a valid UUID stored in the legacy raw format", () => {
    local.seed({ [REPO_STORAGE_KEYS.selectedRepo]: REPO_A });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedRepo]: REPO_A,
    });
  });

  it("keeps a valid UUID stored JSON-encoded by atomWithStorage", () => {
    local.seed({
      [REPO_STORAGE_KEYS.lastUsedRepo]: JSON.stringify(REPO_B),
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.lastUsedRepo]: JSON.stringify(REPO_B),
    });
  });

  it("never touches the branch selection, which is a name and not a UUID", () => {
    // `selected_branch` is deliberately absent from UUID_REPO_KEYS. If it were
    // ever added, every user's branch selection would be wiped on startup.
    local.seed({
      [REPO_STORAGE_KEYS.selectedBranch]: "main",
      [REPO_STORAGE_KEYS.cachedRepos]: JSON.stringify([{ id: REPO_A }]),
      [REPO_STORAGE_KEYS.openedRepos]: JSON.stringify({ main: REPO_A }),
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedBranch]: "main",
      [REPO_STORAGE_KEYS.cachedRepos]: JSON.stringify([{ id: REPO_A }]),
      [REPO_STORAGE_KEYS.openedRepos]: JSON.stringify({ main: REPO_A }),
    });
  });

  it("leaves unrelated application keys completely alone", () => {
    const untouched = {
      theme: "dark",
      "orgii.supabase.auth": '{"access_token":"secret"}',
      opcode_tabs_v3: "[]",
      [`opcode_session_${REPO_A}`]: "{}",
      "orgii:visited-sessions": "[]",
      work_station_terminal_state: "{}",
    };
    local.seed(untouched);

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual(untouched);
  });

  it("keeps a key whose parsed value is not a string, because it cannot be judged", () => {
    // parseStorageValue returns null for non-string JSON, and the removal is
    // gated on `value !== null` — unknown shapes are preserved by design.
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: JSON.stringify({ id: REPO_A }),
      [REPO_STORAGE_KEYS.lastUsedRepo]: "123",
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedRepo]: JSON.stringify({ id: REPO_A }),
      [REPO_STORAGE_KEYS.lastUsedRepo]: "123",
    });
  });

  it("keeps the JSON literal null, which parses to a non-string", () => {
    local.seed({ [REPO_STORAGE_KEYS.selectedRepo]: "null" });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedRepo]: "null",
    });
  });

  it("keeps an empty-string value, which is short-circuited as falsy", () => {
    local.seed({ [REPO_STORAGE_KEYS.selectedRepo]: "" });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({ [REPO_STORAGE_KEYS.selectedRepo]: "" });
  });

  it("keeps git status cache entries keyed by a live UUID, with or without a suffix", () => {
    const kept = {
      [`${GIT_CACHE_PREFIX}${REPO_A}`]: "{}",
      [`${GIT_CACHE_PREFIX}${REPO_B}_branches`]: "{}",
    };
    local.seed(kept);

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual(kept);
  });

  it("keeps keys that merely resemble the git cache prefix", () => {
    const kept = {
      orgii_git_status_cach: "{}",
      orgii_git_status: "{}",
      my_orgii_git_status_cache_garbage: "{}",
    };
    local.seed(kept);

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual(kept);
  });
});

describe("cleanupInvalidUUIDStorage — keys that must go", () => {
  it("removes a raw non-UUID repo selection and nothing else", () => {
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: "my-local-project",
      [REPO_STORAGE_KEYS.selectedBranch]: "main",
      theme: "dark",
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedBranch]: "main",
      theme: "dark",
    });
  });

  it("removes a JSON-encoded non-UUID repo selection", () => {
    local.seed({
      [REPO_STORAGE_KEYS.lastUsedRepo]: JSON.stringify("not-a-uuid"),
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({});
  });

  it('removes the string "undefined", which fails to parse and is not a UUID', () => {
    local.seed({ [REPO_STORAGE_KEYS.selectedRepo]: "undefined" });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({});
  });

  it("removes git cache entries whose UUID segment is malformed, keeping the valid ones", () => {
    local.seed({
      [`${GIT_CACHE_PREFIX}${REPO_A}`]: "keep",
      [`${GIT_CACHE_PREFIX}undefined`]: "drop",
      [`${GIT_CACHE_PREFIX}`]: "drop",
      [`${GIT_CACHE_PREFIX}12345`]: "drop",
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({
      [`${GIT_CACHE_PREFIX}${REPO_A}`]: "keep",
    });
  });

  it("rejects a UUID with the wrong version nibble", () => {
    // Version 6 is outside the [1-5] range the validator accepts.
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: "3f2504e0-4f89-61d3-9a0c-0305e82c3301",
    });

    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual({});
  });
});

describe("cleanupInvalidUUIDStorage — repeatability and failure", () => {
  it("is idempotent: a second pass removes nothing further", () => {
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
      [REPO_STORAGE_KEYS.lastUsedRepo]: REPO_A,
      [`${GIT_CACHE_PREFIX}bad`]: "{}",
      [`${GIT_CACHE_PREFIX}${REPO_A}`]: "{}",
      theme: "dark",
    });

    cleanupModule.cleanupInvalidUUIDStorage();
    const afterFirst = local.snapshot();
    cleanupModule.cleanupInvalidUUIDStorage();

    expect(local.snapshot()).toEqual(afterFirst);
    expect(afterFirst).toEqual({
      [REPO_STORAGE_KEYS.lastUsedRepo]: REPO_A,
      [`${GIT_CACHE_PREFIX}${REPO_A}`]: "{}",
      theme: "dark",
    });
  });

  it("swallows a storage read failure instead of breaking startup", () => {
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
      theme: "dark",
    });
    local.failGetFor((key) => key === REPO_STORAGE_KEYS.selectedRepo);

    expect(() => cleanupModule.cleanupInvalidUUIDStorage()).not.toThrow();
    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
      theme: "dark",
    });
  });

  it("swallows a storage write failure and preserves everything it could not remove", () => {
    local.seed({
      [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
      [`${GIT_CACHE_PREFIX}bad`]: "{}",
      theme: "dark",
    });
    local.failRemoveFor((key) => key === REPO_STORAGE_KEYS.selectedRepo);

    expect(() => cleanupModule.cleanupInvalidUUIDStorage()).not.toThrow();
    // The throw aborts the pass, so the later git-cache sweep never runs.
    // Nothing valid was destroyed, which is the invariant that matters.
    expect(local.snapshot()).toEqual({
      [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
      [`${GIT_CACHE_PREFIX}bad`]: "{}",
      theme: "dark",
    });
  });
});

describe("deferredCleanup", () => {
  it("prefers requestIdleCallback with a 2s timeout when available", () => {
    const requestIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    try {
      cleanupModule.deferredCleanup();

      expect(requestIdleCallback).toHaveBeenCalledTimes(1);
      expect(requestIdleCallback).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 2000,
      });
      // Scheduling alone must not have touched storage.
      expect(local.snapshot()).toEqual({});
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to a 100ms timeout and only then cleans", () => {
    vi.useFakeTimers();
    try {
      local.seed({
        [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
        theme: "dark",
      });

      cleanupModule.deferredCleanup();
      expect(local.snapshot()).toEqual({
        [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
        theme: "dark",
      });

      vi.advanceTimersByTime(99);
      expect(local.snapshot()).toEqual({
        [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
        theme: "dark",
      });

      vi.advanceTimersByTime(1);
      expect(local.snapshot()).toEqual({ theme: "dark" });
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("cleanup module surface", () => {
  it("exports cleanupInvalidUUIDStorage as the default", () => {
    expect(cleanupModule.default).toBe(cleanupModule.cleanupInvalidUUIDStorage);
  });

  it("schedules the deferred cleanup as an import-time side effect", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      local.seed({
        [REPO_STORAGE_KEYS.selectedRepo]: "garbage",
        theme: "dark",
      });

      // Asserted key-by-key rather than on a full snapshot: re-evaluating the
      // module graph also re-runs unrelated atomWithStorage initializers,
      // which add keys of their own.
      await import("./cleanup");
      expect(local.snapshot()[REPO_STORAGE_KEYS.selectedRepo]).toBe("garbage");

      vi.advanceTimersByTime(100);
      expect(local.snapshot()).not.toHaveProperty(
        REPO_STORAGE_KEYS.selectedRepo
      );
      expect(local.snapshot().theme).toBe("dark");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.resetModules();
    }
  });
});
