import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseWebviewLayoutParams } from "../useWebviewLayout";

const invokeMock = vi.fn();
const visibleRectMock = vi.fn();

vi.mock("react", () => ({
  useCallback: <Callback extends (...args: never[]) => unknown>(
    callback: Callback
  ) => callback,
  useEffect: () => undefined,
  useRef: <Value>(value: Value) => ({ current: value }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ rateLimited: vi.fn() }),
}));

vi.mock("@src/hooks/perf/useDebouncedCallback", () => ({
  DEBOUNCE_DELAYS: { FRAME: 16 },
  useDebouncedCallback: (callback: () => void) =>
    Object.assign(callback, {
      cancel: vi.fn(),
      flush: vi.fn(),
      pending: () => false,
    }),
}));

vi.mock("../visibleWebviewRect", () => ({
  getVisibleWebviewRect: visibleRectMock,
}));

const visibleRect = {
  x: 20,
  y: 30,
  width: 800,
  height: 600,
  top: 30,
  right: 820,
  bottom: 630,
  left: 20,
  toJSON: () => ({}),
} as DOMRect;

function createParams(
  overrides: Partial<UseWebviewLayoutParams> = {}
): UseWebviewLayoutParams {
  return {
    containerRef: { current: {} as HTMLDivElement },
    isWebviewCreated: true,
    isWebviewAvailable: true,
    isVisible: true,
    labelRef: { current: "browser-session-test" },
    log: vi.fn(),
    ...overrides,
  };
}

describe("useWebviewLayout native surface commands", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
    visibleRectMock.mockReset();
    visibleRectMock.mockReturnValue(visibleRect);
  });

  it("never writes an on-screen frame while the surface is hidden", async () => {
    const { useWebviewLayout } = await import("../useWebviewLayout");
    const layout = useWebviewLayout(createParams({ isVisible: false }));

    await layout.updatePosition({ force: true });

    expect(invokeMock).toHaveBeenCalledWith("update_inline_webview_position", {
      label: "browser-session-test",
      x: -10000,
      y: -10000,
      width: 1,
      height: 1,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "update_inline_webview_position",
      expect.objectContaining({ x: 20, y: 30 })
    );
  });

  it("repositions and shows in one native command", async () => {
    const { useWebviewLayout } = await import("../useWebviewLayout");
    const layout = useWebviewLayout(createParams());

    await expect(layout.repositionAndShow()).resolves.toBe(true);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("reposition_and_show_webview", {
      label: "browser-session-test",
      x: 20,
      y: 30,
      a: 820,
      b: 630,
      width: 800,
      height: 600,
    });
  });

  it("serializes a later offscreen transition behind an in-flight update", async () => {
    let finishFirst: (() => void) | undefined;
    invokeMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        })
    );

    const { useWebviewLayout } = await import("../useWebviewLayout");
    const layout = useWebviewLayout(createParams());
    const update = layout.updatePosition({ force: true });
    const hide = layout.stageOffscreen({ force: true });

    await Promise.resolve();
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledTimes(1);

    finishFirst?.();
    await Promise.all([update, hide]);

    expect(invokeMock.mock.calls.map(([command]) => command)).toEqual([
      "update_inline_webview_position",
      "update_inline_webview_position",
    ]);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "update_inline_webview_position",
      expect.objectContaining({ x: -10000, y: -10000 })
    );
  });

  it("retries an offscreen write after an IPC failure", async () => {
    invokeMock.mockRejectedValueOnce(new Error("ipc unavailable"));

    const { useWebviewLayout } = await import("../useWebviewLayout");
    const layout = useWebviewLayout(createParams());

    await layout.stageOffscreen();
    await layout.stageOffscreen();

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
