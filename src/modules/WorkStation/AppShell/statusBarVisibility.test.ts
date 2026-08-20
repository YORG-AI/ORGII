import { describe, expect, it } from "vitest";

import { shouldShowWorkStationStatusBar } from "./statusBarVisibility";

describe("shouldShowWorkStationStatusBar", () => {
  it("hides the status bar for My Station chat session tabs", () => {
    expect(
      shouldShowWorkStationStatusBar({
        statusBarHidden: false,
        isAgentStation: false,
        activeTabType: "chat-session",
      })
    ).toBe(false);
  });

  it("keeps the status bar for ordinary My Station tabs", () => {
    expect(
      shouldShowWorkStationStatusBar({
        statusBarHidden: false,
        isAgentStation: false,
        activeTabType: "file",
      })
    ).toBe(true);
  });

  it("preserves the existing global and Agent Station hiding rules", () => {
    expect(
      shouldShowWorkStationStatusBar({
        statusBarHidden: true,
        isAgentStation: false,
        activeTabType: "file",
      })
    ).toBe(false);
    expect(
      shouldShowWorkStationStatusBar({
        statusBarHidden: false,
        isAgentStation: true,
        activeTabType: "file",
      })
    ).toBe(false);
  });
});
