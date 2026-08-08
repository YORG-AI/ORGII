// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import StorageSection from "../sections/StorageSection";

const mocks = vi.hoisted(() => ({
  flushGitHubListCachePersistence: vi.fn(),
  messageSuccess: vi.fn(),
  translate: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: mocks.translate,
  }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "get_disk_usage") {
      return { root_path: "/tmp/orgii", categories: [], total_bytes: 0 };
    }
    if (command === "get_logs_directory") return "/tmp/orgii/logs";
    return undefined;
  }),
}));

vi.mock("@src/services/git/githubListCache", () => ({
  flushGitHubListCachePersistence: mocks.flushGitHubListCachePersistence,
}));

vi.mock("@src/components/Message", () => ({
  default: {
    success: mocks.messageSuccess,
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@src/components/SettingsTable", () => ({
  default: () => null,
  SETTINGS_TABLE_COL: {
    fill: "minmax(0, 1fr)",
    valueMd: "120px",
    hug: "max-content",
  },
}));

function installStorage(initial: Record<string, string>): void {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => Array.from(values.keys())[index] ?? null,
      removeItem: (key: string) => {
        values.delete(key);
      },
      setItem: (key: string, value: string) => values.set(key, String(value)),
    } as Storage,
  });
}

describe("StorageSection browser-cache cleanup", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.flushGitHubListCachePersistence.mockClear();
    mocks.messageSuccess.mockClear();
    installStorage({
      "orgii.ghcache.issues.v1": "regenerable-cache",
      "orgii:org2-cloud-v1:auth": "protected-auth",
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("cleans allowlisted caches while preserving protected state", async () => {
    await act(async () => {
      root.render(createElement(StorageSection));
      await Promise.resolve();
    });

    const cleanupButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="clean-browser-storage"]'
    );
    expect(cleanupButton).not.toBeNull();

    act(() => cleanupButton?.click());

    expect(mocks.flushGitHubListCachePersistence).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("orgii.ghcache.issues.v1")).toBeNull();
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBe(
      "protected-auth"
    );
    expect(mocks.messageSuccess).toHaveBeenCalledTimes(1);
  });
});
