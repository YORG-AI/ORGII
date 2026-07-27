// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useInlineWebviewNativeVisibility } from "../useInlineWebviewNativeVisibility";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const labelRef = { current: "browser-session-test" };

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function VisibilityHarness({
  isVisible,
  updatePosition,
}: {
  isVisible: boolean;
  updatePosition: (options?: {
    force?: boolean;
    show?: boolean;
  }) => Promise<void>;
}) {
  useInlineWebviewNativeVisibility({
    isWebviewCreated: true,
    isVisible,
    isWebviewAvailable: true,
    labelRef,
    updatePosition,
    log: vi.fn(),
  });
  return null;
}

describe("useInlineWebviewNativeVisibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("serializes native transitions and applies the latest visibility intent", async () => {
    const hiddenTransition = deferred();
    const updatePosition = vi.fn().mockResolvedValue(undefined);
    invokeMock.mockReturnValueOnce(hiddenTransition.promise);

    await act(async () => {
      root.render(
        createElement(VisibilityHarness, {
          isVisible: false,
          updatePosition,
        })
      );
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("update_inline_webview_position", {
      label: "browser-session-test",
      x: -10000,
      y: -10000,
      width: 1,
      height: 1,
    });

    await act(async () => {
      root.render(
        createElement(VisibilityHarness, {
          isVisible: true,
          updatePosition,
        })
      );
      await Promise.resolve();
    });
    expect(updatePosition).not.toHaveBeenCalled();

    await act(async () => {
      hiddenTransition.resolve();
      await hiddenTransition.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updatePosition).toHaveBeenCalledTimes(1);
    expect(updatePosition).toHaveBeenCalledWith({ force: true, show: true });
  });

  it("skips a queued show transition that a newer hide supersedes", async () => {
    const firstHide = deferred();
    const updatePosition = vi.fn().mockResolvedValue(undefined);
    invokeMock
      .mockReturnValueOnce(firstHide.promise)
      .mockResolvedValueOnce(undefined);

    await act(async () => {
      root.render(
        createElement(VisibilityHarness, {
          isVisible: false,
          updatePosition,
        })
      );
      await Promise.resolve();
    });

    act(() => {
      root.render(
        createElement(VisibilityHarness, {
          isVisible: true,
          updatePosition,
        })
      );
      root.render(
        createElement(VisibilityHarness, {
          isVisible: false,
          updatePosition,
        })
      );
    });

    await act(async () => {
      firstHide.resolve();
      await firstHide.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(updatePosition).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
