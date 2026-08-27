// @vitest-environment jsdom
// Exercises the click boundary; static markup coverage lives in index.test.ts.
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

import MessageFooter from ".";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

const mocks = vi.hoisted(() => ({
  copyText: vi.fn<(...args: [string]) => Promise<void>>(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@src/util/data/clipboard", () => ({ copyText: mocks.copyText }));
vi.mock("@src/components/Message", () => ({
  default: { error: mocks.error, success: mocks.success },
}));

describe("MessageFooter copy behavior", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.copyText.mockReset();
    mocks.copyText.mockResolvedValue(undefined);
    mocks.error.mockReset();
    mocks.success.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("resolves the complete turn only when the user clicks copy", async () => {
    const getCopyContent = vi.fn(() => "first update\n\nfinal answer");
    await act(async () => {
      root.render(
        createElement(MessageFooter, {
          getCopyContent,
          timestamp: "2026-08-25T00:00:00.000Z",
          timestampLabel: "08:00",
          copyLabel: "Copy turn",
          copiedLabel: "Copied",
          copyFailedLabel: "Copy failed",
        })
      );
    });

    expect(getCopyContent).not.toHaveBeenCalled();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>("[data-testid=message-footer-copy]")
        ?.click();
    });

    expect(getCopyContent).toHaveBeenCalledTimes(1);
    expect(mocks.copyText).toHaveBeenCalledWith("first update\n\nfinal answer");
    expect(mocks.success).toHaveBeenCalledWith("Copied");
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("keeps the action retryable when resolution or clipboard writing fails", async () => {
    const getCopyContent = vi
      .fn<() => string>()
      .mockReturnValueOnce("")
      .mockReturnValue("complete answer");
    mocks.copyText.mockRejectedValueOnce(new Error("denied"));

    await act(async () => {
      root.render(
        createElement(MessageFooter, {
          getCopyContent,
          timestamp: "",
          timestampLabel: "",
          copyLabel: "Copy turn",
          copiedLabel: "Copied",
          copyFailedLabel: "Copy failed",
        })
      );
    });
    const copyButton = container.querySelector<HTMLButtonElement>(
      "[data-testid=message-footer-copy]"
    );

    await act(async () => copyButton?.click());
    await act(async () => copyButton?.click());

    expect(mocks.error).toHaveBeenCalledTimes(2);
    expect(mocks.copyText).toHaveBeenCalledTimes(1);
    expect(container.contains(copyButton)).toBe(true);
  });
});
