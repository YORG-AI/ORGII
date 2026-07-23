// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type UseAsyncResourceResult,
  useAsyncResource,
} from "./useAsyncResource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useAsyncResource", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: UseAsyncResourceResult<string>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  function Harness({
    autoLoad = true,
    enabled = true,
    fetcher,
    initialData = "",
    initialStatus = "idle",
    scopeKey,
  }: {
    autoLoad?: boolean;
    enabled?: boolean;
    fetcher: Parameters<typeof useAsyncResource<string>>[0]["fetcher"];
    initialData?: string;
    initialStatus?: "idle" | "ready";
    scopeKey: string | null;
  }) {
    const result = useAsyncResource({
      autoLoad,
      enabled,
      fetcher,
      initialData,
      initialStatus,
      scopeKey,
    });
    useEffect(() => {
      current = result;
    }, [result]);
    return createElement("div", {
      "data-error": result.error ?? "",
      "data-loading": String(result.loading),
      "data-refreshing": String(result.refreshing),
      "data-status": result.status,
      "data-value": result.data,
    });
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("loads and exposes one cohesive resource state", async () => {
    const request = deferred<string>();
    const fetcher = vi.fn().mockReturnValue(request.promise);
    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));

    expect(container.firstElementChild?.getAttribute("data-status")).toBe(
      "loading"
    );
    request.resolve("loaded");
    await flush();

    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "loaded"
    );
    expect(container.firstElementChild?.getAttribute("data-status")).toBe(
      "ready"
    );
  });

  it("drops a late response and hides old data after switching scope", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockImplementation((scope) =>
        scope === "a" ? first.promise : second.promise
      );

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "b" })));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("");

    second.resolve("new");
    await flush();
    first.resolve("old");
    await flush();

    expect(container.firstElementChild?.getAttribute("data-value")).toBe("new");
  });

  it("starts a new generation for manual refresh and preserves visible data", async () => {
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    stale.resolve("initial");
    await flush();

    let refresh!: Promise<void>;
    act(() => {
      refresh = current.refresh();
    });
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "initial"
    );
    expect(container.firstElementChild?.getAttribute("data-refreshing")).toBe(
      "true"
    );

    fresh.resolve("fresh");
    await act(async () => refresh);
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "fresh"
    );
  });

  it("prevents an active initial load from overwriting a manual refresh", async () => {
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    let refresh!: Promise<void>;
    act(() => {
      refresh = current.refresh();
    });

    fresh.resolve("fresh");
    await act(async () => refresh);
    stale.resolve("stale");
    await flush();
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "fresh"
    );
  });

  it("publishes cache data before the current live request settles", async () => {
    const live = deferred<string>();
    const fetcher = vi.fn(
      async (_scopeKey: string, context: { publish(data: string): void }) => {
        context.publish("cached");
        return live.promise;
      }
    );

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "cached"
    );
    expect(container.firstElementChild?.getAttribute("data-status")).toBe(
      "ready"
    );

    live.resolve("live");
    await flush();
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "live"
    );
  });

  it("can expose seeded cache data without starting a request", () => {
    const fetcher = vi.fn().mockResolvedValue("unused");
    act(() =>
      root.render(
        createElement(Harness, {
          autoLoad: false,
          fetcher,
          initialData: "cached",
          initialStatus: "ready",
          scopeKey: "a",
        })
      )
    );

    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "cached"
    );
    expect(container.firstElementChild?.getAttribute("data-status")).toBe(
      "ready"
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("joins equal non-superseding loads", async () => {
    const request = deferred<string>();
    const fetcher = vi.fn().mockReturnValue(request.promise);
    act(() =>
      root.render(
        createElement(Harness, {
          autoLoad: false,
          fetcher,
          scopeKey: "a",
        })
      )
    );

    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = current.reload();
      second = current.reload();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    request.resolve("joined");
    await act(async () => Promise.all([first, second]));
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "joined"
    );
  });

  it("recovers from error and resets when disabled", async () => {
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("recovered");
    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    await flush();
    expect(container.firstElementChild?.getAttribute("data-error")).toBe(
      "offline"
    );

    await act(async () => current.refresh());
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "recovered"
    );

    act(() =>
      root.render(
        createElement(Harness, {
          enabled: false,
          fetcher,
          scopeKey: "a",
        })
      )
    );
    expect(container.firstElementChild?.getAttribute("data-value")).toBe("");
    expect(container.firstElementChild?.getAttribute("data-status")).toBe(
      "idle"
    );
  });
});
