import { describe, expect, it, vi } from "vitest";

import { subscribeToDropdownOutsideMouseDown } from "./outsideClick";

describe("subscribeToDropdownOutsideMouseDown", () => {
  it("uses capture phase so stopped bubbling cannot keep a dropdown open", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const ownerDocument = {
      addEventListener,
      removeEventListener,
    } as unknown as Document;
    const listener = vi.fn();

    const unsubscribe = subscribeToDropdownOutsideMouseDown(
      ownerDocument,
      listener
    );

    expect(addEventListener).toHaveBeenCalledWith("mousedown", listener, true);

    unsubscribe();

    expect(removeEventListener).toHaveBeenCalledWith(
      "mousedown",
      listener,
      true
    );
  });
});
