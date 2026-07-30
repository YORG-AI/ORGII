import { describe, expect, it } from "vitest";

import { shouldDeliverBackgroundSessionTerminalNotification } from "./backgroundSessionNotifications";

describe("shouldDeliverBackgroundSessionTerminalNotification", () => {
  it("delivers only a new terminal transition for a background session", () => {
    expect(
      shouldDeliverBackgroundSessionTerminalNotification(
        "running",
        "completed",
        true
      )
    ).toBe(true);
    expect(
      shouldDeliverBackgroundSessionTerminalNotification(
        "completed",
        "completed",
        true
      )
    ).toBe(false);
    expect(
      shouldDeliverBackgroundSessionTerminalNotification(
        "failed",
        "completed",
        true
      )
    ).toBe(false);
    expect(
      shouldDeliverBackgroundSessionTerminalNotification(
        "running",
        "completed",
        false
      )
    ).toBe(false);
    expect(
      shouldDeliverBackgroundSessionTerminalNotification(
        "running",
        "working",
        true
      )
    ).toBe(false);
  });
});
