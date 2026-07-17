import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UseWebviewCommandsParams } from "../useWebviewCommands";

const invokeMock = vi.fn();

vi.mock("react", () => ({
  useCallback: <Callback extends (...args: never[]) => unknown>(
    callback: Callback
  ) => callback,
  useRef: <Value>(value: Value) => ({ current: value }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

function createParams(
  overrides: Partial<UseWebviewCommandsParams> = {}
): UseWebviewCommandsParams {
  return {
    isWebviewAvailable: true,
    isUnmountedRef: { current: false },
    containerRef: { current: null },
    labelRef: { current: "browser-session-test" },
    userAgent: "test-agent",
    incognito: false,
    isDestroyedRef: { current: false },
    newWindowListenerRef: { current: null },
    lastPolledUrlRef: { current: "https://example.com" },
    getContainerRect: () => null,
    log: vi.fn(),
    safeUnlisten: vi.fn(),
    isWebviewCreated: true,
    setIsWebviewCreated: vi.fn(),
    setIsLoading: vi.fn(),
    setCurrentUrl: vi.fn(),
    setError: vi.fn(),
    isVisible: true,
    ...overrides,
  };
}

describe("useWebviewCommands reload", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("uses native reload without closing or recreating the inline webview", async () => {
    const { useWebviewCommands } = await import("../useWebviewCommands");
    const setIsLoading = vi.fn();
    const commands = useWebviewCommands(createParams({ setIsLoading }));

    await commands.reload();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("reload_inline_webview", {
      label: "browser-session-test",
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "close_inline_webview",
      expect.anything()
    );
    expect(invokeMock).not.toHaveBeenCalledWith(
      "create_inline_webview",
      expect.anything()
    );
    expect(setIsLoading).toHaveBeenNthCalledWith(1, true);
    expect(setIsLoading).toHaveBeenNthCalledWith(2, false);
  });

  it("does not invoke Tauri when the webview has not been created", async () => {
    const { useWebviewCommands } = await import("../useWebviewCommands");
    const setIsLoading = vi.fn();
    const commands = useWebviewCommands(
      createParams({ isWebviewCreated: false, setIsLoading })
    );

    await commands.reload();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(setIsLoading).not.toHaveBeenCalled();
  });
});
