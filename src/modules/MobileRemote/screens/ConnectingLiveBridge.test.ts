// @vitest-environment jsdom
import React, { act } from "react";
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

import { ConnectingLiveBridge } from "./ConnectingLiveBridge";

const mocks = vi.hoisted(() => ({
  connectLive: vi.fn(),
  refreshSessions: vi.fn(),
}));

vi.mock("../app", () => ({
  useMobileRemote: () => ({
    connectLive: mocks.connectLive,
    refreshSessions: mocks.refreshSessions,
  }),
}));

vi.mock("./ConnectingScreen", () => ({
  ConnectingScreen: () => React.createElement("div", null, "connecting"),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ConnectingLiveBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

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
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("finishes navigation when connection state rerenders during setup", async () => {
    const connection = deferred();
    const onComplete = vi.fn();
    const pendingConfig = {
      wsUrl: "wss://relay.example.com/v1/mobile/ws",
      deviceToken: "device-token",
      pairingCode: "PAIR-1",
    };
    mocks.connectLive.mockReturnValue(connection.promise);

    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: false,
          onComplete,
        })
      );
    });
    expect(mocks.connectLive).toHaveBeenCalledOnce();

    mocks.refreshSessions = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: false,
          onComplete,
        })
      );
    });

    await act(async () => {
      connection.resolve();
      await connection.promise;
    });

    expect(mocks.connectLive).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("finishes navigation when demo mode clears during the live connect", async () => {
    const connection = deferred();
    const onComplete = vi.fn();
    const pendingConfig = {
      wsUrl: "wss://relay.example.com/v1/mobile/ws",
      deviceToken: "device-token",
      pairingCode: "PAIR-1",
    };
    mocks.connectLive.mockReturnValue(connection.promise);

    // First run pairs out of the demo bootstrap, so demoMode starts true.
    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: true,
          onComplete,
        })
      );
    });
    expect(mocks.connectLive).toHaveBeenCalledOnce();

    // connectLive flips connection.demoMode to false mid-attempt.
    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: false,
          onComplete,
        })
      );
    });

    await act(async () => {
      connection.resolve();
      await connection.promise;
    });

    expect(mocks.connectLive).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("keeps the connecting screen when the live connect fails", async () => {
    const onComplete = vi.fn();
    const pendingConfig = {
      wsUrl: "wss://relay.example.com/v1/mobile/ws",
      deviceToken: "device-token",
      pairingCode: "PAIR-1",
    };
    mocks.connectLive.mockRejectedValue(new Error("WebSocket closed"));

    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: true,
          onComplete,
        })
      );
    });
    await act(async () => {
      root.render(
        React.createElement(ConnectingLiveBridge, {
          pendingConfig,
          demoMode: false,
          onComplete,
        })
      );
    });

    expect(mocks.connectLive).toHaveBeenCalledOnce();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("completes the demo timer path when no pairing config is pending", async () => {
    vi.useFakeTimers();
    try {
      const onComplete = vi.fn();

      await act(async () => {
        root.render(
          React.createElement(ConnectingLiveBridge, {
            pendingConfig: null,
            demoMode: true,
            onComplete,
          })
        );
      });
      expect(mocks.connectLive).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });

      expect(onComplete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
