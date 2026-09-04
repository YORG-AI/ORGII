import { afterEach, describe, expect, it } from "vitest";

import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
  Org2CloudEndpointOverrideSchema,
  buildCloudAuthBridgeUrl,
  buildCloudAuthCallbackUrl,
  buildCloudBillingLoginUrl,
  buildOrg2CloudLoginUrl,
  configureCloudAuthCallbackForIdentifier,
  getCloudEndpoint,
} from "./config";

const OVERRIDE = {
  webOrigin: "https://cloud.acme.dev",
  supabaseUrl: "https://supabase.acme.dev",
  anonKey: "sb_publishable_custom",
};

function storeOverride(value: unknown): void {
  localStorage.setItem(
    ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
    JSON.stringify(value)
  );
}

afterEach(() => {
  localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
  configureCloudAuthCallbackForIdentifier("org2ai.org2");
});

describe("getCloudEndpoint", () => {
  it("defaults to the official endpoint when no override is stored", () => {
    expect(getCloudEndpoint()).toEqual({
      webOrigin: ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
      supabaseUrl: ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
      anonKey: ORG2_CLOUD_OFFICIAL_ANON_KEY,
      isOfficial: true,
    });
  });

  it("resolves a stored override with isOfficial=false, without a reload", () => {
    storeOverride(OVERRIDE);
    expect(getCloudEndpoint()).toEqual({ ...OVERRIDE, isOfficial: false });
  });

  it("treats a stored null (reset-to-official) as official", () => {
    storeOverride(null);
    expect(getCloudEndpoint().isOfficial).toBe(true);
  });

  it("degrades corrupted JSON to the official endpoint", () => {
    localStorage.setItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY, "{not json");
    expect(getCloudEndpoint().isOfficial).toBe(true);
  });

  it("degrades a schema-invalid remote http override to the official endpoint", () => {
    storeOverride({ ...OVERRIDE, supabaseUrl: "http://supabase.acme.dev" });
    expect(getCloudEndpoint().isOfficial).toBe(true);
  });

  it("resolves a loopback http override for local self-hosted development", () => {
    const local = {
      ...OVERRIDE,
      webOrigin: "http://localhost:54321",
      supabaseUrl: "http://127.0.0.1:54321",
    };
    storeOverride(local);
    expect(getCloudEndpoint()).toEqual({ ...local, isOfficial: false });
  });
});

describe("buildCloudAuthCallbackUrl", () => {
  it("supports an isolated desktop instance scheme", () => {
    expect(buildCloudAuthCallbackUrl("orgii-instance2")).toBe(
      "orgii-instance2://auth/callback"
    );
  });

  it("falls back to the production scheme for invalid input", () => {
    expect(buildCloudAuthCallbackUrl("not a scheme")).toBe(
      "orgii://auth/callback"
    );
  });

  it("derives an isolated callback from the runtime Tauri identifier", () => {
    expect(
      configureCloudAuthCallbackForIdentifier("org2ai.org2.instance2")
    ).toBe("orgii-instance2://auth/callback");
    expect(
      new URL(buildOrg2CloudLoginUrl()).searchParams.get("return_to")
    ).toBe("orgii-instance2://auth/callback");
  });

  it("rejects malformed and unbounded runtime instance identifiers", () => {
    for (const identifier of [
      "org2ai.org2.instance1",
      "org2ai.org2.instance100",
      "org2ai.org2.instance2.extra",
      "other.orgii.instance2",
    ]) {
      expect(configureCloudAuthCallbackForIdentifier(identifier)).toBe(
        "orgii://auth/callback"
      );
    }
  });
});

describe("Org2CloudEndpointOverrideSchema", () => {
  it("accepts https URLs and a non-empty anon key", () => {
    expect(Org2CloudEndpointOverrideSchema.safeParse(OVERRIDE).success).toBe(
      true
    );
  });

  it("rejects remote http URLs on both URL fields", () => {
    expect(
      Org2CloudEndpointOverrideSchema.safeParse({
        ...OVERRIDE,
        webOrigin: "http://cloud.acme.dev",
      }).success
    ).toBe(false);
    expect(
      Org2CloudEndpointOverrideSchema.safeParse({
        ...OVERRIDE,
        supabaseUrl: "http://supabase.acme.dev",
      }).success
    ).toBe(false);
  });

  it("accepts http only for loopback hosts", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        Org2CloudEndpointOverrideSchema.safeParse({
          ...OVERRIDE,
          webOrigin: `http://${host}:54321`,
          supabaseUrl: `http://${host}:54321`,
        }).success
      ).toBe(true);
    }
  });

  it("rejects strings that are not URLs at all", () => {
    expect(
      Org2CloudEndpointOverrideSchema.safeParse({
        ...OVERRIDE,
        supabaseUrl: "supabase.acme.dev",
      }).success
    ).toBe(false);
  });

  it("rejects an empty anon key", () => {
    expect(
      Org2CloudEndpointOverrideSchema.safeParse({
        ...OVERRIDE,
        anonKey: "   ",
      }).success
    ).toBe(false);
  });
});

describe("buildCloudBillingLoginUrl", () => {
  it("routes through web login with a /billing return target", () => {
    const url = new URL(buildCloudBillingLoginUrl());
    expect(url.origin).toBe(ORG2_CLOUD_OFFICIAL_WEB_ORIGIN);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("return_to")).toBe("/billing");
  });

  it("never carries desktop credentials", () => {
    const url = new URL(buildCloudBillingLoginUrl());
    expect(url.hash).toBe("");
    expect(url.toString()).not.toContain("access_token");
    expect(url.toString()).not.toContain("refresh_token");
  });

  it("follows a custom endpoint's web origin", () => {
    storeOverride(OVERRIDE);
    const url = new URL(buildCloudBillingLoginUrl());
    expect(url.origin).toBe(OVERRIDE.webOrigin);
    expect(url.pathname).toBe("/login");
  });
});

describe("buildCloudAuthBridgeUrl", () => {
  it("targets the official web origin by default", () => {
    expect(buildCloudAuthBridgeUrl()).toBe(
      `${ORG2_CLOUD_OFFICIAL_WEB_ORIGIN}/api/auth/bridge`
    );
  });

  it("follows a custom endpoint's web origin", () => {
    storeOverride(OVERRIDE);
    expect(buildCloudAuthBridgeUrl()).toBe(
      `${OVERRIDE.webOrigin}/api/auth/bridge`
    );
  });

  it("uses an explicitly passed origin", () => {
    expect(buildCloudAuthBridgeUrl("https://cloud.other.dev")).toBe(
      "https://cloud.other.dev/api/auth/bridge"
    );
  });
});

describe("buildOrg2CloudLoginUrl", () => {
  it("keeps the login URL on the same origin with the deep-link return", () => {
    const url = new URL(buildOrg2CloudLoginUrl());
    expect(url.origin).toBe(ORG2_CLOUD_OFFICIAL_WEB_ORIGIN);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("return_to")).toBe("orgii://auth/callback");
  });

  it("accepts an ephemeral loopback return for tauri dev", () => {
    const callback =
      "http://localhost:43123/org2-cloud/auth/callback?state=b8c71b7e-7ac6-4ebd-aeab-c1976bb01e9d";
    const url = new URL(buildOrg2CloudLoginUrl(callback));
    expect(url.searchParams.get("return_to")).toBe(callback);
  });

  it("follows a custom endpoint's web origin", () => {
    storeOverride(OVERRIDE);
    const url = new URL(buildOrg2CloudLoginUrl());
    expect(url.origin).toBe(OVERRIDE.webOrigin);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("return_to")).toBe("orgii://auth/callback");
  });
});
