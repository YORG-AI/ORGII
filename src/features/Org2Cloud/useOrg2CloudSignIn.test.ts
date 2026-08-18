import { describe, expect, it, vi } from "vitest";

import { ORG2_CLOUD_OFFICIAL_WEB_ORIGIN } from "./config";
import { openOrg2CloudSignIn } from "./useOrg2CloudSignIn";

describe("openOrg2CloudSignIn", () => {
  it("delegates browser ownership to the native Broker in the PKCE rollout", async () => {
    const beginBrokerSignIn = vi.fn(async () => undefined);
    const beginAuthLoopback = vi.fn(async () => "unused");
    const openExternalUrl = vi.fn(async () => undefined);

    await openOrg2CloudSignIn({
      useBrokerOAuth: true,
      beginBrokerSignIn,
      beginAuthLoopback,
      openExternalUrl,
    });

    expect(beginBrokerSignIn).toHaveBeenCalledTimes(1);
    expect(beginAuthLoopback).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("opens login with the app-owned loopback callback", async () => {
    const callbackUrl =
      "http://localhost:49152/org2-cloud/auth/callback?state=06a011d0-3c35-4f81-90cf-468eddd89631";
    const beginAuthLoopback = vi.fn(async () => callbackUrl);
    const openExternalUrl = vi.fn(async (_url: string) => undefined);

    await openOrg2CloudSignIn({
      useBrokerOAuth: false,
      beginAuthLoopback,
      openExternalUrl,
    });

    expect(beginAuthLoopback).toHaveBeenCalledTimes(1);
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    const url = new URL(openExternalUrl.mock.calls[0][0]);
    expect(url.origin).toBe(ORG2_CLOUD_OFFICIAL_WEB_ORIGIN);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("return_to")).toBe(callbackUrl);
  });

  it("cancels the pending receiver when the browser cannot be opened", async () => {
    const cancelAuthLoopback = vi.fn(async () => undefined);
    const openError = new Error("browser unavailable");

    await expect(
      openOrg2CloudSignIn({
        useBrokerOAuth: false,
        beginAuthLoopback: async () =>
          "http://localhost:49152/org2-cloud/auth/callback?state=06a011d0-3c35-4f81-90cf-468eddd89631",
        cancelAuthLoopback,
        openExternalUrl: async () => {
          throw openError;
        },
      })
    ).rejects.toBe(openError);
    expect(cancelAuthLoopback).toHaveBeenCalledTimes(1);
  });
});
