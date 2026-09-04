import { describe, expect, it } from "vitest";

import { resolveMobileSessionTitle } from "./sessionPresentation";

describe("resolveMobileSessionTitle", () => {
  it("uses the desktop session name", () => {
    expect(
      resolveMobileSessionTitle(
        [
          {
            id: "codexapp-rollout-1",
            name: "解释这是什么意思",
            status: "idle",
          },
        ],
        "codexapp-rollout-1"
      )
    ).toBe("解释这是什么意思");
  });

  it("falls back to the id when the session is missing or unnamed", () => {
    expect(resolveMobileSessionTitle([], "sde-missing")).toBe("sde-missing");
    expect(
      resolveMobileSessionTitle(
        [{ id: "sde-empty", name: "   ", status: "idle" }],
        "sde-empty"
      )
    ).toBe("sde-empty");
  });
});
