import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  createKeyboardActivationHandler,
  getInteractiveTabIndex,
  isKeyboardActivationKey,
} from "../keyboardActivation";

describe("isKeyboardActivationKey", () => {
  it("accepts Enter and Space", () => {
    expect(isKeyboardActivationKey("Enter")).toBe(true);
    expect(isKeyboardActivationKey(" ")).toBe(true);
  });

  it("rejects other keys", () => {
    expect(isKeyboardActivationKey("Escape")).toBe(false);
    expect(isKeyboardActivationKey("Tab")).toBe(false);
  });
});

describe("createKeyboardActivationHandler", () => {
  it("runs the action on Enter", () => {
    const action = vi.fn();
    const handler = createKeyboardActivationHandler(action);

    handler({
      key: "Enter",
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("runs the action on Space and prevents default scrolling", () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    const handler = createKeyboardActivationHandler(action);

    handler({ key: " ", preventDefault } as unknown as KeyboardEvent);

    expect(action).toHaveBeenCalledTimes(1);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not run the action on unrelated keys", () => {
    const action = vi.fn();
    const preventDefault = vi.fn();
    const handler = createKeyboardActivationHandler(action);

    handler({ key: "Escape", preventDefault } as unknown as KeyboardEvent);

    expect(action).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("getInteractiveTabIndex", () => {
  it("returns 0 when enabled and -1 when disabled", () => {
    expect(getInteractiveTabIndex(false)).toBe(0);
    expect(getInteractiveTabIndex(true)).toBe(-1);
  });
});
