import { afterEach, describe, expect, it } from "vitest";

import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
} from "./config";
import {
  CloudShareEndpointMismatchError,
  requireCloudShareAuthEndpoint,
  resolveCloudShareEndpoint,
  resolvePersistedCloudShareEndpoint,
} from "./org2CloudShareEndpoint";

afterEach(() => {
  localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
});

function configureCustomEndpoint(supabaseUrl: string): void {
  localStorage.setItem(
    ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
    JSON.stringify({
      webOrigin: "https://app.custom.example.com",
      supabaseUrl,
      anonKey: "custom-anon",
    })
  );
}

describe("resolveCloudShareEndpoint", () => {
  it("pins official shares to managed cloud without changing active custom config", () => {
    configureCustomEndpoint("https://db.custom.example.com");
    const endpoint = resolveCloudShareEndpoint({ kind: "official" });
    expect(endpoint.supabaseUrl).toBe(ORG2_CLOUD_OFFICIAL_SUPABASE_URL);
    expect(resolveCloudShareEndpoint({ kind: "current" }).supabaseUrl).toBe(
      "https://db.custom.example.com"
    );
  });

  it("accepts a custom share only when that deployment is configured", () => {
    configureCustomEndpoint("https://db.custom.example.com");
    expect(
      resolveCloudShareEndpoint({
        kind: "custom",
        supabaseUrl: "https://db.custom.example.com",
      }).anonKey
    ).toBe("custom-anon");
  });

  it("refuses to send a custom share token to a different endpoint", () => {
    expect(() =>
      resolveCloudShareEndpoint({
        kind: "custom",
        supabaseUrl: "https://db.custom.example.com",
      })
    ).toThrow(CloudShareEndpointMismatchError);
  });

  it("restores an official persisted share independently of current custom config", () => {
    configureCustomEndpoint("https://db.custom.example.com");
    expect(
      resolvePersistedCloudShareEndpoint(ORG2_CLOUD_OFFICIAL_SUPABASE_URL)
        .supabaseUrl
    ).toBe(ORG2_CLOUD_OFFICIAL_SUPABASE_URL);
  });

  it("accepts only the endpoint that issued the current auth token", () => {
    const endpoint = resolveCloudShareEndpoint({ kind: "official" });
    expect(
      requireCloudShareAuthEndpoint(
        endpoint,
        `${ORG2_CLOUD_OFFICIAL_SUPABASE_URL}/`
      )
    ).toBe(endpoint);
    expect(() =>
      requireCloudShareAuthEndpoint(endpoint, "https://db.custom.example.com")
    ).toThrow(CloudShareEndpointMismatchError);
  });

  it("does not send an official token to a configured custom share endpoint", () => {
    configureCustomEndpoint("https://db.custom.example.com");
    const endpoint = resolveCloudShareEndpoint({ kind: "current" });
    expect(() =>
      requireCloudShareAuthEndpoint(endpoint, ORG2_CLOUD_OFFICIAL_SUPABASE_URL)
    ).toThrow(CloudShareEndpointMismatchError);
  });
});
