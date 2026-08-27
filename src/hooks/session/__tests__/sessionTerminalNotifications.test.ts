import { describe, expect, it } from "vitest";

import { shouldDeliverSessionTerminalNotification } from "../sessionTerminalNotifications";

describe("shouldDeliverSessionTerminalNotification", () => {
  it("delivers only a new terminal transition", () => {
    expect(
      shouldDeliverSessionTerminalNotification("running", "completed")
    ).toBe(true);
    expect(
      shouldDeliverSessionTerminalNotification("completed", "completed")
    ).toBe(false);
    expect(
      shouldDeliverSessionTerminalNotification("failed", "completed")
    ).toBe(false);
    expect(shouldDeliverSessionTerminalNotification("running", "working")).toBe(
      false
    );
  });
});
