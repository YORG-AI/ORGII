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
  type WSContextValue,
  WSProvider,
  type WSProviderProps,
  useWSClient,
} from "./WSProvider";

const mocks = vi.hoisted(() => ({
  destroyWSClient: vi.fn(),
  initWSClient: vi.fn(),
}));

vi.mock("./client", () => ({
  OrgiiaiWSClient: class OrgiiaiWSClient {},
  destroyWSClient: mocks.destroyWSClient,
  initWSClient: mocks.initWSClient,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function createClient() {
  return {
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
    on: vi.fn(() => vi.fn()),
  };
}

describe("WSProvider lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: WSContextValue | null;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    mocks.initWSClient.mockImplementation(() => createClient());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const Capture = () => {
    const value = useWSClient();
    useEffect(() => {
      latest = value;
    }, [value]);
    return null;
  };

  async function render(options: { pingInterval?: number }) {
    await act(async () => {
      root.render(
        createElement(
          WSProvider,
          {
            serverUrl: "ws://example.test/api/ws",
            sessionId: "session-1",
            autoConnect: false,
            options,
          } as WSProviderProps,
          createElement(Capture)
        )
      );
      await Promise.resolve();
    });
  }

  it("keeps the connection for equivalent option objects and rebuilds for option changes", async () => {
    await render({ pingInterval: 1_000 });
    const firstClient = mocks.initWSClient.mock.results[0]?.value;

    expect(mocks.initWSClient).toHaveBeenCalledTimes(1);
    expect(mocks.initWSClient).toHaveBeenLastCalledWith(
      "ws://example.test/api/ws",
      "session-1",
      { debug: false, pingInterval: 1_000 }
    );
    expect(latest?.client).toBe(firstClient);

    await render({ pingInterval: 1_000 });
    expect(mocks.initWSClient).toHaveBeenCalledTimes(1);
    expect(mocks.destroyWSClient).not.toHaveBeenCalled();

    await render({ pingInterval: 2_000 });
    expect(mocks.destroyWSClient).toHaveBeenCalledTimes(1);
    expect(mocks.initWSClient).toHaveBeenCalledTimes(2);
    expect(mocks.initWSClient).toHaveBeenLastCalledWith(
      "ws://example.test/api/ws",
      "session-1",
      { debug: false, pingInterval: 2_000 }
    );
  });

  it("does not pass undefined values that would overwrite client defaults", async () => {
    await render({ pingInterval: undefined });

    expect(mocks.initWSClient).toHaveBeenCalledWith(
      "ws://example.test/api/ws",
      "session-1",
      { debug: false }
    );
  });
});
