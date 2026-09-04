// @vitest-environment jsdom
import { act, createElement } from "react";
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

import TrafficLights from ".";

const mocks = vi.hoisted(() => {
  const currentWindow = {
    close: vi.fn(),
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: vi.fn(),
  };

  return {
    currentWindow,
    getCurrent: vi.fn(() => currentWindow),
    loggerError: vi.fn(),
  };
});

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getCurrent: mocks.getCurrent },
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: mocks.loggerError }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("TrafficLights", () => {
  let container: HTMLDivElement;
  let root: Root;

  function controls(): HTMLDivElement[] {
    const buttons = Array.from(
      container.querySelectorAll<HTMLDivElement>(".title-bar-buttons > div")
    );
    expect(buttons).toHaveLength(3);
    return buttons;
  }

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrent.mockReturnValue(mocks.currentWindow);
    mocks.currentWindow.close.mockResolvedValue(undefined);
    mocks.currentWindow.minimize.mockResolvedValue(undefined);
    mocks.currentWindow.maximize.mockResolvedValue(undefined);
    mocks.currentWindow.unmaximize.mockResolvedValue(undefined);
    mocks.currentWindow.isMaximized.mockResolvedValue(false);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses custom window-control handlers instead of Tauri", async () => {
    const onClose = vi.fn().mockResolvedValue(undefined);
    const onMinimize = vi.fn().mockResolvedValue(undefined);
    const onMaximize = vi.fn().mockResolvedValue(undefined);

    act(() => {
      root.render(
        createElement(TrafficLights, { onClose, onMinimize, onMaximize })
      );
    });

    const [close, minimize, maximize] = controls();
    await act(async () => {
      close.click();
      minimize.click();
      maximize.click();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onMinimize).toHaveBeenCalledOnce();
    expect(onMaximize).toHaveBeenCalledOnce();
    expect(mocks.getCurrent).not.toHaveBeenCalled();
  });

  it("closes and minimizes the current Tauri window by default", async () => {
    act(() => {
      root.render(createElement(TrafficLights));
    });

    const [close, minimize] = controls();
    await act(async () => {
      close.click();
      minimize.click();
      await Promise.resolve();
    });

    expect(mocks.currentWindow.close).toHaveBeenCalledOnce();
    expect(mocks.currentWindow.minimize).toHaveBeenCalledOnce();
    expect(mocks.getCurrent).toHaveBeenCalledTimes(2);
  });

  it("restores the current window when it is maximized", async () => {
    mocks.currentWindow.isMaximized.mockResolvedValue(true);
    act(() => {
      root.render(createElement(TrafficLights));
    });

    const [, , maximize] = controls();
    await act(async () => {
      maximize.click();
      await Promise.resolve();
    });

    expect(mocks.currentWindow.isMaximized).toHaveBeenCalledOnce();
    expect(mocks.currentWindow.unmaximize).toHaveBeenCalledOnce();
    expect(mocks.currentWindow.maximize).not.toHaveBeenCalled();
  });

  it("maximizes the current window when it is not maximized", async () => {
    act(() => {
      root.render(createElement(TrafficLights));
    });

    const [, , maximize] = controls();
    await act(async () => {
      maximize.click();
      await Promise.resolve();
    });

    expect(mocks.currentWindow.isMaximized).toHaveBeenCalledOnce();
    expect(mocks.currentWindow.maximize).toHaveBeenCalledOnce();
    expect(mocks.currentWindow.unmaximize).not.toHaveBeenCalled();
  });

  it("does not invoke a maximize handler or Tauri when maximize is disabled", () => {
    const onMaximize = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        createElement(TrafficLights, { disableMaximize: true, onMaximize })
      );
    });

    const [, , maximize] = controls();
    expect(maximize.className).toContain("cursor-not-allowed");
    expect(maximize.className).toContain("opacity-50");

    act(() => maximize.click());

    expect(onMaximize).not.toHaveBeenCalled();
    expect(mocks.getCurrent).not.toHaveBeenCalled();
  });
});
