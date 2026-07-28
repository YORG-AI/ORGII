import { describe, expect, it, vi } from "vitest";

import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

import {
  POINTER_CURSORS_ATTRIBUTE,
  applyPointerCursorPreference,
} from "../usePointerCursorPreference";

describe("pointer cursor preference", () => {
  it("is disabled by default and preserves an explicit opt-in", () => {
    expect(getSettingsDefaults()["general.usePointerCursors"]).toBe(false);
    expect(
      validateSettings({ "general.usePointerCursors": true })[
        "general.usePointerCursors"
      ]
    ).toBe(true);
  });

  it.each([true, false])(
    "sets enabled=%s and cleans up the document-root attribute",
    (enabled) => {
      const target = {
        setAttribute: vi.fn(),
        removeAttribute: vi.fn(),
      };

      const cleanup = applyPointerCursorPreference(target, enabled);

      expect(target.setAttribute).toHaveBeenCalledWith(
        POINTER_CURSORS_ATTRIBUTE,
        String(enabled)
      );

      cleanup();

      expect(target.removeAttribute).toHaveBeenCalledWith(
        POINTER_CURSORS_ATTRIBUTE
      );
    }
  );
});
