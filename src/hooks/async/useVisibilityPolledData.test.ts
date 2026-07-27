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
  type UseVisibilityPolledDataResult,
  useVisibilityPolledData,
} from "./useVisibilityPolledData";

const pollMocks = vi.hoisted(() => ({
  start: vi.fn(),
}));

vi.mock("@src/util/core/visibilityAwarePoll", () => ({
  startVisibilityAwarePoll: pollMocks.start,
}));

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

describe("useVisibilityPolledData", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: UseVisibilityPolledDataResult<string>;
  let pollTasks: Array<() => Promise<void> | void>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  function Harness({
    enabled = true,
    fetcher,
    scopeKey,
  }: {
    enabled?: boolean;
    fetcher: (scopeKey: string) => Promise<string>;
    scopeKey: string | null;
  }) {
    const result = useVisibilityPolledData({
      enabled,
      fetcher,
      initialData: "",
      intervalMs: 1_500,
      scopeKey,
    });
    useEffect(() => {
      current = result;
    }, [result]);
    return createElement("div", {
      "data-error": result.error ?? "",
      "data-loading": String(result.loading),
      "data-value": result.data,
    });
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    pollTasks = [];
    pollMocks.start.mockReset().mockImplementation((options) => {
      pollTasks.push(options.task);
      if (options.runImmediately) void options.task();
      return { runNow: vi.fn(), stop: vi.fn() };
    });
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

  it("loads once, then refreshes in the background without clearing data", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe(
      "true"
    );

    first.resolve("first");
    await flush();
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "first"
    );
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe(
      "false"
    );

    let background!: Promise<void>;
    act(() => {
      background = Promise.resolve(pollTasks.at(-1)?.());
    });
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "first"
    );
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe(
      "false"
    );

    second.resolve("second");
    await act(async () => background);
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "second"
    );
  });

  it("drops a late response after switching scope", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockImplementation((scope) =>
        scope === "a" ? first.promise : second.promise
      );

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "b" })));

    second.resolve("new scope");
    await flush();
    first.resolve("old scope");
    await flush();

    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "new scope"
    );
  });

  it("recovers from failure through manual refresh", async () => {
    const failed = deferred<string>();
    const fetcher = vi
      .fn<(scopeKey: string) => Promise<string>>()
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValueOnce("recovered");

    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    failed.reject(new Error("offline"));
    await flush();
    expect(container.firstElementChild?.getAttribute("data-error")).toBe(
      "offline"
    );

    await act(async () => current.refresh());
    expect(container.firstElementChild?.getAttribute("data-value")).toBe(
      "recovered"
    );
    expect(container.firstElementChild?.getAttribute("data-error")).toBe("");
  });

  it("clears scoped data and stops polling when disabled", async () => {
    const fetcher = vi.fn().mockResolvedValue("loaded");
    act(() => root.render(createElement(Harness, { fetcher, scopeKey: "a" })));
    await flush();

    act(() =>
      root.render(
        createElement(Harness, { enabled: false, fetcher, scopeKey: "a" })
      )
    );

    expect(container.firstElementChild?.getAttribute("data-value")).toBe("");
    expect(container.firstElementChild?.getAttribute("data-loading")).toBe(
      "false"
    );
  });
});
