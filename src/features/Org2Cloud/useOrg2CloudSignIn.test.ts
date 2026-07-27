import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
  configureCloudAuthCallbackForIdentifier,
} from "./config";
import { openOrg2CloudSignIn } from "./useOrg2CloudSignIn";

afterEach(() => {
  configureCloudAuthCallbackForIdentifier("yorg.orgii");
});

describe("openOrg2CloudSignIn", () => {
  it("opens the login route with an explicit desktop return target", async () => {
    const openExternalUrl = vi.fn(async (_url: string) => undefined);

    await openOrg2CloudSignIn(openExternalUrl);

    expect(openExternalUrl).toHaveBeenCalledTimes(1);
    const url = new URL(openExternalUrl.mock.calls[0][0]);
    expect(url.origin).toBe(ORG2_CLOUD_OFFICIAL_WEB_ORIGIN);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("return_to")).toBe("orgii://auth/callback");
  });

  it("uses the running isolated instance's registered callback", async () => {
    configureCloudAuthCallbackForIdentifier("yorg.orgii.instance2");
    const openExternalUrl = vi.fn(async (_url: string) => undefined);

    await openOrg2CloudSignIn(openExternalUrl);

    const url = new URL(openExternalUrl.mock.calls[0][0]);
    expect(url.searchParams.get("return_to")).toBe(
      "orgii-instance2://auth/callback"
    );
  });
});
