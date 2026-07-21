import { describe, expect, it } from "vitest";

import { isTerminalTurnStatus } from "../turnFinality";

describe("turn metadata finality", () => {
  it.each(["completed", "interrupted", "failed"] as const)(
    "shows metadata for terminal status %s",
    (status) => {
      expect(isTerminalTurnStatus(status)).toBe(true);
    }
  );

  it.each(["pending", "working"] as const)(
    "hides metadata for active status %s",
    (status) => {
      expect(isTerminalTurnStatus(status)).toBe(false);
    }
  );
});
