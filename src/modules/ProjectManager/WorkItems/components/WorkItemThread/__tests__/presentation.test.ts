import { describe, expect, it } from "vitest";

import { resolveWorkItemThreadHeaderPolicy } from "../presentation";

describe("resolveWorkItemThreadHeaderPolicy", () => {
  it("omits the metadata band when no path or properties exist", () => {
    expect(resolveWorkItemThreadHeaderPolicy(false, false)).toEqual({
      showHeader: false,
      showSeparator: false,
    });
  });

  it.each([
    [true, false],
    [false, true],
  ])(
    "renders a single header source without a separator",
    (hasPath, hasProperties) => {
      expect(resolveWorkItemThreadHeaderPolicy(hasPath, hasProperties)).toEqual(
        {
          showHeader: true,
          showSeparator: false,
        }
      );
    }
  );

  it("separates the path from properties when both are present", () => {
    expect(resolveWorkItemThreadHeaderPolicy(true, true)).toEqual({
      showHeader: true,
      showSeparator: true,
    });
  });
});
