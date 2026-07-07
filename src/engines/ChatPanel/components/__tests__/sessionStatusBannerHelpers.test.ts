import { describe, expect, it } from "vitest";

import {
  resolveSessionFailedBannerDescription,
  shouldShowComposerActivityHud,
  shouldShowSessionFailedBanner,
  shouldShowSessionInstallingBanner,
} from "../sessionStatusBannerHelpers";

describe("shouldShowSessionFailedBanner", () => {
  it("returns true only for failed status", () => {
    expect(shouldShowSessionFailedBanner("failed")).toBe(true);
    expect(shouldShowSessionFailedBanner("running")).toBe(false);
    expect(shouldShowSessionFailedBanner("idle")).toBe(false);
    expect(shouldShowSessionFailedBanner("cancelled")).toBe(false);
  });
});

describe("shouldShowSessionInstallingBanner", () => {
  it("returns true only for installing status", () => {
    expect(shouldShowSessionInstallingBanner("installing")).toBe(true);
    expect(shouldShowSessionInstallingBanner("running")).toBe(false);
    expect(shouldShowSessionInstallingBanner("failed")).toBe(false);
  });
});

describe("shouldShowComposerActivityHud", () => {
  it("hides while stream retry, failed, or installing", () => {
    expect(
      shouldShowComposerActivityHud({
        runtimeStatus: "running",
        hasStreamRetry: true,
      })
    ).toBe(false);
    expect(
      shouldShowComposerActivityHud({
        runtimeStatus: "failed",
        hasStreamRetry: false,
      })
    ).toBe(false);
    expect(
      shouldShowComposerActivityHud({
        runtimeStatus: "installing",
        hasStreamRetry: false,
      })
    ).toBe(false);
  });

  it("shows for active running sessions without retry", () => {
    expect(
      shouldShowComposerActivityHud({
        runtimeStatus: "running",
        hasStreamRetry: false,
      })
    ).toBe(true);
  });
});

describe("resolveSessionFailedBannerDescription", () => {
  it("returns trimmed error when present", () => {
    expect(
      resolveSessionFailedBannerDescription("  connection reset  ", "fallback")
    ).toBe("connection reset");
  });

  it("falls back when error is empty", () => {
    expect(resolveSessionFailedBannerDescription("", "Press Retry")).toBe(
      "Press Retry"
    );
    expect(resolveSessionFailedBannerDescription(null, "Press Retry")).toBe(
      "Press Retry"
    );
  });
});
