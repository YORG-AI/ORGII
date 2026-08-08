// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { GlobalErrorHandler } from "./index";

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

describe("GlobalErrorHandler", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    createInstrumentedStore();
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

  it("keeps the app mounted and releases caches for quota errors", async () => {
    await act(async () => {
      root.render(
        createElement(
          GlobalErrorHandler,
          null,
          createElement("div", { "data-testid": "app-content" }, "App content")
        )
      );
      await Promise.resolve();
    });
    const quotaError = new Error("The quota has been exceeded.");
    quotaError.name = "QuotaExceededError";
    const event = new ErrorEvent("error", {
      cancelable: true,
      error: quotaError,
      message: quotaError.message,
    });

    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(
      container.querySelector('[data-testid="app-content"]')
    ).not.toBeNull();
    expect(localStorage.getItem("orgii.ghcache.issues.v1")).toBeNull();
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBe(
      "protected-auth"
    );
  });
});
