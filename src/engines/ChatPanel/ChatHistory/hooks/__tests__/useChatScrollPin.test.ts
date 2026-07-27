import { describe, expect, it } from "vitest";

import { didAppendGroupAtTail } from "../useChatScrollPin";

describe("didAppendGroupAtTail", () => {
  it("does not treat an older-history prepend as a new tail group", () => {
    expect(
      didAppendGroupAtTail(
        ["turn-10", "turn-11"],
        ["turn-9", "turn-10", "turn-11"]
      )
    ).toBe(false);
  });

  it("recognizes a true tail append without relying on the array length alone", () => {
    expect(
      didAppendGroupAtTail(
        ["turn-10", "turn-11"],
        ["turn-10", "turn-11", "turn-12"]
      )
    ).toBe(true);
  });

  it("fails closed when stable group identities are unavailable", () => {
    expect(
      didAppendGroupAtTail(["turn-10", null], ["turn-10", null, "turn-12"])
    ).toBe(false);
  });
});
