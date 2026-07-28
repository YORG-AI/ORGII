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
  type UseBrowserConsoleOptions,
  type UseBrowserConsoleReturn,
  useBrowserConsole,
} from "./useBrowserConsole";
import {
  type UseBrowserNetworkLogsOptions,
  type UseBrowserNetworkLogsReturn,
  useBrowserNetworkLogs,
} from "./useBrowserNetworkLogs";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("browser diagnostics lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("releases console rows and rejects a poll that finishes after close", async () => {
    let latest: UseBrowserConsoleReturn | null = null;
    const request = deferred<
      Array<{
        level: string;
        message: string;
        timestamp: number;
        url: string;
        stack: string | null;
      }>
    >();
    mocks.invoke.mockReturnValue(request.promise);

    const Harness = ({
      onValue,
      ...options
    }: UseBrowserConsoleOptions & {
      onValue: (value: UseBrowserConsoleReturn) => void;
    }) => {
      const value = useBrowserConsole(options);
      useEffect(() => onValue(value), [onValue, value]);
      return null;
    };
    const capture = (value: UseBrowserConsoleReturn) => {
      latest = value;
    };

    act(() => {
      root.render(
        createElement(Harness, {
          enabled: true,
          sessionId: "session-1",
          webviewLabel: "browser-session-1",
          pollInterval: 0,
          onValue: capture,
        })
      );
    });
    act(() => latest!.addEntry("log", "retained while open"));
    expect(latest!.entries).toHaveLength(1);

    let poll!: Promise<void>;
    act(() => {
      poll = latest!.pollNow();
    });
    act(() => {
      root.render(
        createElement(Harness, {
          enabled: false,
          sessionId: "session-1",
          webviewLabel: "browser-session-1",
          pollInterval: 0,
          onValue: capture,
        })
      );
    });
    expect(latest!.entries).toEqual([]);

    await act(async () => {
      request.resolve([
        {
          level: "error",
          message: "late result",
          timestamp: Date.now(),
          url: "https://example.test",
          stack: null,
        },
      ]);
      await poll;
    });
    expect(latest!.entries).toEqual([]);
  });

  it("releases network rows and rejects a poll that finishes after close", async () => {
    let latest: UseBrowserNetworkLogsReturn | null = null;
    const request = deferred<
      Array<{
        id: string;
        type: string;
        method: string;
        url: string;
        startTime: number;
        status: number | null;
        duration: number | null;
        size: string | null;
        error: string | null;
      }>
    >();
    mocks.invoke.mockReturnValue(request.promise);

    const Harness = ({
      onValue,
      ...options
    }: UseBrowserNetworkLogsOptions & {
      onValue: (value: UseBrowserNetworkLogsReturn) => void;
    }) => {
      const value = useBrowserNetworkLogs(options);
      useEffect(() => onValue(value), [onValue, value]);
      return null;
    };
    const capture = (value: UseBrowserNetworkLogsReturn) => {
      latest = value;
    };

    act(() => {
      root.render(
        createElement(Harness, {
          enabled: true,
          sessionId: "session-1",
          webviewLabel: "browser-session-1",
          pollInterval: 0,
          onValue: capture,
        })
      );
    });
    let poll!: Promise<void>;
    act(() => {
      poll = latest!.pollNow();
    });
    act(() => {
      root.render(
        createElement(Harness, {
          enabled: false,
          sessionId: "session-1",
          webviewLabel: "browser-session-1",
          pollInterval: 0,
          onValue: capture,
        })
      );
    });

    await act(async () => {
      request.resolve([
        {
          id: "request-1",
          type: "fetch",
          method: "GET",
          url: "https://example.test",
          startTime: Date.now(),
          status: 500,
          duration: 10,
          size: null,
          error: "late result",
        },
      ]);
      await poll;
    });
    expect(latest!.entries).toEqual([]);
  });
});
