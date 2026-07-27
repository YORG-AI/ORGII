import { afterEach, describe, expect, it } from "vitest";

import { getCloudEndpoint } from "./config";
import {
  endpointForOrg,
  resetOrgEndpointDirectory,
  setAnonKeyDirectory,
  setOrgEndpointDirectory,
} from "./org2CloudOrgEndpointRouter";

afterEach(() => resetOrgEndpointDirectory());

describe("org endpoint router", () => {
  it("falls back to the official endpoint for unknown orgs", () => {
    expect(endpointForOrg("nope")).toEqual(getCloudEndpoint());
  });

  it("routes a directory entry and drops it on republish", () => {
    const home = {
      ...getCloudEndpoint(),
      supabaseUrl: "https://shard.example",
    };
    setOrgEndpointDirectory([["org-a", home]]);
    expect(endpointForOrg("org-a").supabaseUrl).toBe("https://shard.example");
    setOrgEndpointDirectory([]);
    expect(endpointForOrg("org-a")).toEqual(getCloudEndpoint());
  });

  it("swaps the anon key for origins with a shard key, else falls back", () => {
    const home = {
      ...getCloudEndpoint(),
      supabaseUrl: "https://shard.example",
    };
    setOrgEndpointDirectory([["org-a", home]]);
    setAnonKeyDirectory([["https://shard.example", "shard-anon-key"]]);
    expect(endpointForOrg("org-a").anonKey).toBe("shard-anon-key");
    expect(endpointForOrg("unrouted").anonKey).toBe(getCloudEndpoint().anonKey);
  });
});
