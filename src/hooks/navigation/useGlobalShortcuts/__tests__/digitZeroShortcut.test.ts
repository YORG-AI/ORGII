import { describe, expect, it } from "vitest";

import { resolveDigitZeroShortcut } from "../digitZeroShortcut";

describe("resolveDigitZeroShortcut", () => {
  it("resets zoom for the plain modifier-plus-zero chord", () => {
    expect(resolveDigitZeroShortcut({ altKey: false, shiftKey: false })).toBe(
      "zoom_reset"
    );
  });

  it("keeps reset zoom on the alternate zero chord", () => {
    expect(resolveDigitZeroShortcut({ altKey: true, shiftKey: false })).toBe(
      "zoom_reset"
    );
  });

  it("keeps route debugging on shift-zero", () => {
    expect(resolveDigitZeroShortcut({ altKey: false, shiftKey: true })).toBe(
      "route_debug_modal"
    );
  });

  it("does not claim an ambiguous alt-shift-zero chord", () => {
    expect(
      resolveDigitZeroShortcut({ altKey: true, shiftKey: true })
    ).toBeNull();
  });
});
