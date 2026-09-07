import { describe, expect, it } from "vitest";

import { credentialedAccounts } from "./credentialedAccounts";

describe("credentialedAccounts", () => {
  it("does not count ambient, disabled, or empty rows as saved credentials", () => {
    const enabled = { id: "enabled", enabled: true, hasKey: true };

    expect(
      credentialedAccounts([
        enabled,
        { id: "disabled", enabled: false, hasKey: true },
        { id: "empty", enabled: true, hasKey: false },
      ])
    ).toEqual([enabled]);
  });
});
