import { describe, expect, it } from "vitest";

import { shouldEnableBrowserLogPolling } from "./browserDiagnosticsPolicy";

describe("shouldEnableBrowserLogPolling", () => {
  it("disables diagnostic polling in production bundles", () => {
    expect(shouldEnableBrowserLogPolling(true, "production")).toBe(false);
  });

  it("allows polling only for an enabled non-production host", () => {
    expect(shouldEnableBrowserLogPolling(true, "development")).toBe(true);
    expect(shouldEnableBrowserLogPolling(true, "test")).toBe(true);
    expect(shouldEnableBrowserLogPolling(false, "development")).toBe(false);
  });
});
