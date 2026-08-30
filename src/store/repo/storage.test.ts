import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  REPO_STORAGE_KEYS,
  clearAllOpenedRepos,
  getOpenedReposMap,
  registerOpenedRepo,
  unregisterWindow,
} from "./storage";

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    warn: vi.fn(),
  }),
}));

interface StorageControls {
  failWrites: boolean;
  setItem: ReturnType<typeof vi.fn>;
}

function installStorage(initial: Record<string, string> = {}): StorageControls {
  const values = new Map(Object.entries(initial));
  const controls: StorageControls = {
    failWrites: false,
    setItem: vi.fn((key: string, value: string) => {
      if (controls.failWrites) {
        const error = new Error("The quota has been exceeded.");
        error.name = "QuotaExceededError";
        throw error;
      }
      values.set(key, String(value));
    }),
  };
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: controls.setItem,
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;

  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
  return controls;
}

beforeEach(() => {
  installStorage();
});

describe("opened repository storage", () => {
  it("persists main-window repository selection", () => {
    registerOpenedRepo("main", "repo-1");

    expect(getOpenedReposMap()).toEqual({ main: "repo-1" });
  });

  it("keeps capability-globbed secondary windows out of the registry", () => {
    registerOpenedRepo("app-window-session-osagent-1", "repo-1");

    expect(getOpenedReposMap()).toEqual({});
  });

  it("does not rewrite an unchanged repository selection", () => {
    const controls = installStorage({
      [REPO_STORAGE_KEYS.openedRepos]: JSON.stringify({ main: "repo-1" }),
    });

    registerOpenedRepo("main", "repo-1");

    expect(controls.setItem).not.toHaveBeenCalled();
  });

  it("degrades a quota-exceeded registration without throwing", () => {
    const controls = installStorage();
    controls.failWrites = true;

    expect(() => registerOpenedRepo("main", "repo-1")).not.toThrow();
    expect(getOpenedReposMap()).toEqual({});
  });

  it("degrades a quota-exceeded unregister without throwing", () => {
    const controls = installStorage({
      [REPO_STORAGE_KEYS.openedRepos]: JSON.stringify({ main: "repo-1" }),
    });
    controls.failWrites = true;

    expect(() => unregisterWindow("main")).not.toThrow();
    expect(getOpenedReposMap()).toEqual({ main: "repo-1" });
  });

  it("clears the ephemeral registry without affecting repository selection", () => {
    installStorage({
      [REPO_STORAGE_KEYS.openedRepos]: JSON.stringify({ main: "repo-1" }),
    });

    expect(() => clearAllOpenedRepos()).not.toThrow();
    expect(getOpenedReposMap()).toEqual({});
  });
});
