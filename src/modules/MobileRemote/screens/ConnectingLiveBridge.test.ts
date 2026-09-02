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

import { MobileRemotePlatformProvider } from "../platform";
import { createBrowserMobileRemotePlatform } from "../platform/browser";
import type { MobileRemotePlatform } from "../platform/types";
import { ConnectingLiveBridge } from "./ConnectingLiveBridge";

const mocks = vi.hoisted(() => ({
  connectLive: vi.fn(),
  refreshSessions: vi.fn(),
}));

const TestMobileRemotePlatformProvider =
  MobileRemotePlatformProvider as React.ComponentType<
    React.PropsWithChildren<
      Omit<
        React.ComponentProps<typeof MobileRemotePlatformProvider>,
        "children"
      >
    >
  >;

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

function renderBridge(
  platform: MobileRemotePlatform,
  pendingConfig: {
    wsUrl: string;
    deviceToken: string;
    pairingCode: string;
  },
  onComplete: () => void
) {
  return React.createElement(
    TestMobileRemotePlatformProvider,
    { platform },
    React.createElement(ConnectingLiveBridge, {
      pendingConfig,
      demoMode: false,
      onComplete,
    })
  );
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
    const platform = createBrowserMobileRemotePlatform();
    const pendingConfig = {
      wsUrl: "wss://relay.example.com/v1/mobile/ws",
      deviceToken: "device-token",
      pairingCode: "PAIR-1",
    };
    mocks.connectLive.mockReturnValue(connection.promise);

    await act(async () => {
      root.render(renderBridge(platform, pendingConfig, onComplete));
    });
    expect(mocks.connectLive).toHaveBeenCalledOnce();

    mocks.refreshSessions = vi.fn();
    await act(async () => {
      root.render(renderBridge(platform, pendingConfig, onComplete));
    });

    await act(async () => {
      connection.resolve();
      await connection.promise;
    });

    expect(mocks.connectLive).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
