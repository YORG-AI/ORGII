import { describe, expect, it } from "vitest";

import { reflectWindowFocusState } from "./useWindowFocusTracking";

function focusDocument(hasFocus: boolean, hidden: boolean) {
  return {
    hidden,
    hasFocus: () => hasFocus,
    documentElement: { dataset: {} as DOMStringMap },
  };
}

describe("reflectWindowFocusState", () => {
  it("marks a visible focused window as active", () => {
    const target = focusDocument(true, false);

    expect(reflectWindowFocusState(target)).toBe(true);
    expect(target.documentElement.dataset.windowFocused).toBe("true");
  });

  it.each([
    { hasFocus: false, hidden: false },
    { hasFocus: true, hidden: true },
    { hasFocus: false, hidden: true },
  ])("marks $hasFocus/$hidden windows inactive", ({ hasFocus, hidden }) => {
    const target = focusDocument(hasFocus, hidden);

    expect(reflectWindowFocusState(target)).toBe(false);
    expect(target.documentElement.dataset.windowFocused).toBe("false");
  });
});
