// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("mobileRemoteEntry", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
    window.history.replaceState(
      null,
      "",
      "/orgii/mobile#pair=opaque-pairing-credential"
    );
  });

  afterEach(() => {
    vi.doUnmock("react-dom/client");
    vi.doUnmock("@src/modules/MobileRemote/mobileI18n");
  });

  it("scrubs a pairing credential before waiting for i18n startup", async () => {
    const createRoot = vi.fn();
    const mobileI18nReady = new Promise<void>(() => undefined);
    vi.doMock("react-dom/client", () => ({ createRoot }));
    vi.doMock("@src/modules/MobileRemote/mobileI18n", () => ({
      getMobileStartupErrorMessage: vi.fn(),
      mobileI18n: {},
      mobileI18nReady,
    }));

    await import("./mobileRemoteEntry");

    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/orgii/mobile");
    expect(createRoot).not.toHaveBeenCalled();
    expect(
      sessionStorage.getItem("orgii:mobile-auth-v1:pending-pairing")
    ).toContain("opaque-pairing-credential");
  });
});
