import { describe, expect, it } from "vitest";

import { formatDispatchFailureMessage } from "../dispatchFailureMessage";

describe("formatDispatchFailureMessage", () => {
  it("returns base message when detail is empty", () => {
    expect(formatDispatchFailureMessage("Failed to send message")).toBe(
      "Failed to send message"
    );
    expect(formatDispatchFailureMessage("Failed to send message", "  ")).toBe(
      "Failed to send message"
    );
  });

  it("appends trimmed detail when present", () => {
    expect(
      formatDispatchFailureMessage("Failed to send message", "network error")
    ).toBe("Failed to send message: network error");
  });
});
