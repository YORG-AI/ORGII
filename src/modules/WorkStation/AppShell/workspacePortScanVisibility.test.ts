import { describe, expect, it } from "vitest";

import { shouldEnableWorkspacePortScan } from "./workspacePortScanVisibility";

const visibleWorkspace = {
  isActive: true,
  chatPanelFocused: false,
  hasActiveTab: true,
  isLaunchpad: false,
  isAgentStation: false,
};

describe("shouldEnableWorkspacePortScan", () => {
  it("keeps the port scanner active in Browser and Terminal", () => {
    expect(
      shouldEnableWorkspacePortScan({
        ...visibleWorkspace,
        isCodeMode: false,
        isBrowserMode: true,
      })
    ).toBe(true);
    expect(
      shouldEnableWorkspacePortScan({
        ...visibleWorkspace,
        // Terminal tabs render through the Code host.
        isCodeMode: true,
        isBrowserMode: false,
      })
    ).toBe(true);
  });

  it.each([
    { isActive: false },
    { chatPanelFocused: true },
    { hasActiveTab: false },
    { isLaunchpad: true },
    { isAgentStation: true },
  ])("stops scanning outside an eligible visible surface: %o", (override) => {
    expect(
      shouldEnableWorkspacePortScan({
        ...visibleWorkspace,
        isCodeMode: true,
        isBrowserMode: false,
        ...override,
      })
    ).toBe(false);
  });
});
