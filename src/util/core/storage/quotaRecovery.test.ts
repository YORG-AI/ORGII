import { beforeEach, describe, expect, it } from "vitest";

import {
  BROWSER_CACHE_STORAGE_KEYS,
  cleanUpBrowserStorage,
  inspectBrowserStorage,
  isStorageQuotaError,
  setBrowserStorageItemWithRecovery,
} from "./quotaRecovery";

interface TestStorage extends Storage {
  failUntilBytesBelow: number | null;
  values: Map<string, string>;
}

function createStorage(initial: Record<string, string> = {}): TestStorage {
  const values = new Map(Object.entries(initial));
  const storage = {
    values,
    failUntilBytesBelow: null,
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
      const currentBytes = Array.from(values.values()).reduce(
        (total, item) => total + item.length * 2,
        0
      );
      if (
        storage.failUntilBytesBelow !== null &&
        currentBytes >= storage.failUntilBytesBelow
      ) {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, value);
    },
  } as TestStorage;
  return storage;
}

let storage: TestStorage;

beforeEach(() => {
  storage = createStorage();
});

describe("browser storage quota recovery", () => {
  it("identifies WebKit quota errors without classifying unrelated failures", () => {
    const quotaError = new Error("The quota has been exceeded.");
    quotaError.name = "QuotaExceededError";

    expect(isStorageQuotaError(quotaError)).toBe(true);
    expect(isStorageQuotaError(new Error("Network unavailable"))).toBe(false);
  });

  it("reports only allowlisted caches as cleanable", () => {
    storage = createStorage({
      [BROWSER_CACHE_STORAGE_KEYS.githubIssues]: "x".repeat(100),
      "orgii:org2-cloud-v1:auth": "protected-auth",
      "orgii:chat-image-draft:session-1": "protected-draft",
    });

    const usage = inspectBrowserStorage(storage);

    expect(usage.keyCount).toBe(3);
    expect(usage.cleanableKeyCount).toBe(1);
    expect(usage.cleanableBytes).toBeGreaterThan(0);
  });

  it("manual cleanup preserves protected state", () => {
    storage = createStorage({
      "orgii.ghcache.issues.v1": "legacy",
      [BROWSER_CACHE_STORAGE_KEYS.githubIssues]: "current",
      [BROWSER_CACHE_STORAGE_KEYS.sessionList]: "sessions",
      "orgii:org2-cloud-v1:pushCursors": "protected-cursors",
      "orgii:chat-image-draft:session-1": "protected-draft",
    });

    const result = cleanUpBrowserStorage("all-disposable", storage);

    expect(result.removedKeys).toEqual(
      expect.arrayContaining([
        "orgii.ghcache.issues.v1",
        BROWSER_CACHE_STORAGE_KEYS.githubIssues,
        BROWSER_CACHE_STORAGE_KEYS.sessionList,
      ])
    );
    expect(storage.getItem("orgii:org2-cloud-v1:pushCursors")).toBe(
      "protected-cursors"
    );
    expect(storage.getItem("orgii:chat-image-draft:session-1")).toBe(
      "protected-draft"
    );
  });

  it("startup cleanup removes legacy versions without deleting current caches", () => {
    storage = createStorage({
      "orgii.ghcache.issues.v1": "legacy",
      [BROWSER_CACHE_STORAGE_KEYS.githubIssues]: "current",
      "orgii:org2-cloud-v1:auth": "protected-auth",
    });

    const result = cleanUpBrowserStorage("obsolete", storage);

    expect(result.removedKeys).toEqual(["orgii.ghcache.issues.v1"]);
    expect(storage.getItem(BROWSER_CACHE_STORAGE_KEYS.githubIssues)).toBe(
      "current"
    );
    expect(storage.getItem("orgii:org2-cloud-v1:auth")).toBe("protected-auth");
  });

  it("evicts regenerable caches and retries a quota-exceeded write", () => {
    storage = createStorage({
      "orgii.ghcache.issues.v1": "x".repeat(1_000),
      [BROWSER_CACHE_STORAGE_KEYS.sessionList]: "sessions",
      "orgii:org2-cloud-v1:auth": "protected-auth",
    });
    storage.failUntilBytesBelow = 1_000;

    const result = setBrowserStorageItemWithRecovery(
      "orgii:visited-sessions",
      JSON.stringify(["session-1"]),
      storage
    );

    expect(result.persisted).toBe(true);
    expect(result.recovered).toBe(true);
    expect(storage.getItem("orgii.ghcache.issues.v1")).toBeNull();
    expect(storage.getItem("orgii:org2-cloud-v1:auth")).toBe("protected-auth");
    expect(storage.getItem(BROWSER_CACHE_STORAGE_KEYS.sessionList)).toBe(
      "sessions"
    );
  });
});
