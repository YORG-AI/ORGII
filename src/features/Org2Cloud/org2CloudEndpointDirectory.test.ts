import { describe, expect, it } from "vitest";

import type { CloudEndpoint } from "./config";
import {
  orgsGroupedByEndpoint,
  resolveOrgEndpoint,
} from "./org2CloudEndpointDirectory";

const OFFICIAL: CloudEndpoint = {
  webOrigin: "https://org2-cloud-infra.vercel.app",
  supabaseUrl: "https://official.supabase.co",
  anonKey: "anon-key",
  isOfficial: true,
};

describe("resolveOrgEndpoint", () => {
  it("returns the official endpoint when homeEndpoint is absent", () => {
    expect(resolveOrgEndpoint({}, OFFICIAL)).toBe(OFFICIAL);
  });

  it("returns the official endpoint when homeEndpoint matches it", () => {
    expect(
      resolveOrgEndpoint(
        { homeEndpoint: "https://official.supabase.co" },
        OFFICIAL
      )
    ).toBe(OFFICIAL);
  });

  it("swaps only the supabaseUrl for a differing https origin", () => {
    expect(
      resolveOrgEndpoint(
        { homeEndpoint: "https://shard-2.supabase.co" },
        OFFICIAL
      )
    ).toEqual({
      webOrigin: "https://org2-cloud-infra.vercel.app",
      supabaseUrl: "https://shard-2.supabase.co",
      anonKey: "anon-key",
      isOfficial: true,
    });
  });

  it.each([
    "",
    "not-a-url",
    "http://shard-2.supabase.co",
    "https://shard-2.supabase.co/rest/v1",
    "https://shard-2.supabase.co/",
    "ftp://shard-2.supabase.co",
  ])("returns the official endpoint for garbage origin %j", (homeEndpoint) => {
    expect(resolveOrgEndpoint({ homeEndpoint }, OFFICIAL)).toBe(OFFICIAL);
  });
});

interface RosterOrg {
  orgId: string;
  name: string;
  homeEndpoint?: string;
}

describe("orgsGroupedByEndpoint", () => {
  it("partitions a roster by resolved home project", () => {
    const home: RosterOrg = { orgId: "org-1", name: "Home" };
    const homeExplicit = {
      orgId: "org-2",
      name: "Home explicit",
      homeEndpoint: "https://official.supabase.co",
    };
    const sharded = {
      orgId: "org-3",
      name: "Sharded",
      homeEndpoint: "https://shard-2.supabase.co",
    };
    const shardedSibling = {
      orgId: "org-4",
      name: "Sharded sibling",
      homeEndpoint: "https://shard-2.supabase.co",
    };
    const garbage = {
      orgId: "org-5",
      name: "Garbage",
      homeEndpoint: "not-a-url",
    };

    const groups = orgsGroupedByEndpoint(
      [home, homeExplicit, sharded, shardedSibling, garbage],
      OFFICIAL
    );

    expect([...groups.keys()]).toEqual([
      "https://official.supabase.co",
      "https://shard-2.supabase.co",
    ]);
    expect(groups.get("https://official.supabase.co")).toEqual({
      endpoint: OFFICIAL,
      orgs: [home, homeExplicit, garbage],
    });
    expect(groups.get("https://shard-2.supabase.co")).toEqual({
      endpoint: { ...OFFICIAL, supabaseUrl: "https://shard-2.supabase.co" },
      orgs: [sharded, shardedSibling],
    });
  });

  it("returns an empty map for an empty roster", () => {
    expect(orgsGroupedByEndpoint([], OFFICIAL).size).toBe(0);
  });
});
