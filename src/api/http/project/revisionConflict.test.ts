import { describe, expect, it } from "vitest";

import { parseRevisionConflict } from "./revisionConflict";

describe("parseRevisionConflict", () => {
  it("parses the named expected/actual contract", () => {
    expect(
      parseRevisionConflict(
        "invoke failed: PM_ERR:REVISION_CONFLICT:expected=4:actual=7"
      )
    ).toEqual({ expected: 4, actual: 7 });
  });

  it("keeps rolling compatibility with the legacy positional contract", () => {
    expect(parseRevisionConflict("PM_ERR:REVISION_CONFLICT:4:7")).toEqual({
      expected: 4,
      actual: 7,
    });
  });

  it("rejects unrelated errors", () => {
    expect(parseRevisionConflict("network offline")).toBeNull();
  });
});
