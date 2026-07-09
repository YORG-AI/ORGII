/**
 * Tests for containerDropHelpers.ts
 *
 * Verifies that `isInternalDropType` correctly identifies which drop events
 * should be forwarded to the internal `handleDrop` handler vs treated as
 * OS file drops (which are handled by GlobalDragDrop).
 *
 * Context: useContainerDrag unconditionally calls event.preventDefault() and
 * event.stopPropagation() for ALL drops so that OS file drops never reach the
 * contenteditable host and trigger browser-default text insertion (issue #250).
 * Only internal-type drops are additionally forwarded to handleDrop.
 */
import { describe, expect, it } from "vitest";

import { isInternalDropType } from "../containerDropHelpers";

describe("isInternalDropType", () => {
  describe("OS file drops — should NOT route to handleDrop", () => {
    it("returns false for plain OS file drop (Files type only)", () => {
      expect(isInternalDropType(["Files"], false, false)).toBe(false);
    });

    it("returns false with empty types array", () => {
      expect(isInternalDropType([], false, false)).toBe(false);
    });

    it("returns false for text/plain drop", () => {
      expect(isInternalDropType(["text/plain"], false, false)).toBe(false);
    });

    it("returns false for text/uri-list drop", () => {
      expect(
        isInternalDropType(["text/plain", "text/uri-list"], false, false)
      ).toBe(false);
    });
  });

  describe("internal file-tree drag — should route to handleDrop", () => {
    it("returns true when isInternalFileTreeActive is true", () => {
      expect(isInternalDropType([], true, false)).toBe(true);
    });

    it("returns true even with OS file types when flag is set", () => {
      expect(isInternalDropType(["Files"], true, false)).toBe(true);
    });
  });

  describe("application/x-file-reference — should route to handleDrop", () => {
    it("returns true when types contains application/x-file-reference", () => {
      expect(
        isInternalDropType(["application/x-file-reference"], false, false)
      ).toBe(true);
    });

    it("returns true with mixed types including file-reference", () => {
      expect(
        isInternalDropType(
          ["text/plain", "application/x-file-reference"],
          false,
          false
        )
      ).toBe(true);
    });
  });

  describe("reference drag data — should route to handleDrop", () => {
    it("returns true when hasReferenceData is true", () => {
      expect(isInternalDropType(["text/plain"], false, true)).toBe(true);
    });

    it("returns true when both flag and reference data are set", () => {
      expect(isInternalDropType([], true, true)).toBe(true);
    });
  });

  describe("boundary / combined cases", () => {
    it("returns false when none of the conditions are met", () => {
      expect(isInternalDropType(["text/html", "Files"], false, false)).toBe(
        false
      );
    });

    it("prioritises any truthy condition — OR logic", () => {
      expect(isInternalDropType([], false, true)).toBe(true);
      expect(isInternalDropType([], true, false)).toBe(true);
      expect(
        isInternalDropType(["application/x-file-reference"], false, false)
      ).toBe(true);
    });
  });
});
