import { describe, expect, it, vi } from "vitest";

import {
  buildSlashActionCommand,
  insertAtomicSlashActionPill,
} from "./slashItemUtils";

describe("built-in slash action insertion", () => {
  it("inserts Canvas and Compact as atomic composer pills", () => {
    for (const actionName of ["canvas", "compact"]) {
      const composer = {
        insertFilePill: vi.fn(),
        focus: vi.fn(),
      };

      expect(insertAtomicSlashActionPill(composer, actionName)).toBe(true);
      expect(composer.insertFilePill).toHaveBeenCalledWith(
        `/${actionName}`,
        false,
        "skill",
        actionName
      );
      expect(composer.focus).toHaveBeenCalledOnce();
    }
  });

  it("leaves non-atomic actions to the caller's text fallback", () => {
    const composer = {
      insertFilePill: vi.fn(),
      focus: vi.fn(),
    };

    expect(insertAtomicSlashActionPill(composer, "setup-repo")).toBe(false);
    expect(composer.insertFilePill).not.toHaveBeenCalled();
    expect(buildSlashActionCommand("setup-repo")).toBe("/setup-repo ");
  });
});
