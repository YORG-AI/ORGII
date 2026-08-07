import { describe, expect, it } from "vitest";

import type { Org2CloudOrg } from "../org2CloudOrgsAtom";
import { buildCloudOrgSelectorValue } from "../org2CloudOrgsAtom";
import {
  getActiveCloudShareOrgsForSession,
  getCloudShareOrgsForSession,
} from "./shareEligibility";

const ORGS: Org2CloudOrg[] = [
  { orgId: "org-a", name: "Alpha", role: "owner" },
  { orgId: "org-b", name: "Beta", role: "member" },
];

describe("getCloudShareOrgsForSession", () => {
  it("matches an explicitly cloud-owned session inside the repo scope", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "s1", orgId: buildCloudOrgSelectorValue("org-a") },
      {},
      ORGS,
      { "org-a": ["github.com/acme/alpha"] },
      ["github.com/acme/alpha"]
    );
    expect(orgs.map((org) => org.orgId)).toEqual(["org-a"]);
  });

  it("matches a tagged org when ANY checkout remote hits its scope", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "s1" },
      { s1: [buildCloudOrgSelectorValue("org-b")] },
      ORGS,
      { "org-b": ["github.com/team/alpha"] },
      // origin = personal fork (primary), upstream = the team repo.
      ["github.com/me/alpha", "github.com/team/alpha"]
    );
    expect(orgs.map((org) => org.orgId)).toEqual(["org-b"]);
  });

  it("allows multiple explicitly tagged orgs without duplicating", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "s1" },
      {
        s1: [
          buildCloudOrgSelectorValue("org-a"),
          buildCloudOrgSelectorValue("org-b"),
        ],
      },
      ORGS,
      {
        "org-a": ["github.com/acme/alpha"],
        "org-b": ["github.com/acme/alpha"],
      },
      ["github.com/acme/alpha"]
    );
    expect(orgs.map((org) => org.orgId)).toEqual(["org-a", "org-b"]);
  });

  it("unresolved (undefined) or absent scope keys match nothing", () => {
    expect(
      getCloudShareOrgsForSession(
        { session_id: "s1", orgId: buildCloudOrgSelectorValue("org-a") },
        {},
        ORGS,
        { "org-a": ["github.com/acme/alpha"] },
        undefined
      )
    ).toEqual([]);
    expect(
      getCloudShareOrgsForSession(
        { session_id: "s1", orgId: buildCloudOrgSelectorValue("org-a") },
        {},
        ORGS,
        { "org-a": ["github.com/acme/alpha"] },
        null
      )
    ).toEqual([]);
  });

  it("an org with no scopes is never shareable (scope is the hard boundary)", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "s1", orgId: buildCloudOrgSelectorValue("org-a") },
      {},
      ORGS,
      {},
      ["github.com/acme/alpha"]
    );
    expect(orgs).toEqual([]);
  });

  it("never treats a matching remote as org ownership for a Personal session", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "personal-session", orgId: "personal-org" },
      {},
      ORGS,
      {
        "org-a": ["github.com/acme/alpha"],
        "org-b": ["github.com/acme/alpha"],
      },
      ["github.com/acme/alpha"]
    );
    expect(orgs).toEqual([]);
  });

  it("does not share a cloud-owned session into a second org with the same remote", () => {
    const orgs = getCloudShareOrgsForSession(
      { session_id: "s1", orgId: buildCloudOrgSelectorValue("org-a") },
      {},
      ORGS,
      {
        "org-a": ["github.com/acme/alpha"],
        "org-b": ["github.com/acme/alpha"],
      },
      ["github.com/acme/alpha"]
    );
    expect(orgs.map((org) => org.orgId)).toEqual(["org-a"]);
  });
});

describe("getActiveCloudShareOrgsForSession", () => {
  const taggedForBoth = {
    s1: [
      buildCloudOrgSelectorValue("org-a"),
      buildCloudOrgSelectorValue("org-b"),
    ],
  };
  const sharedScopes = {
    "org-a": ["github.com/acme/alpha"],
    "org-b": ["github.com/acme/alpha"],
  };

  it("offers no cloud roster while the user is in Personal", () => {
    expect(
      getActiveCloudShareOrgsForSession(
        null,
        { session_id: "s1" },
        taggedForBoth,
        ORGS,
        sharedScopes,
        ["github.com/acme/alpha"]
      )
    ).toEqual([]);
  });

  it("offers only the currently selected cloud org", () => {
    expect(
      getActiveCloudShareOrgsForSession(
        "org-b",
        { session_id: "s1" },
        taggedForBoth,
        ORGS,
        sharedScopes,
        ["github.com/acme/alpha"]
      ).map((org) => org.orgId)
    ).toEqual(["org-b"]);
  });

  it("does not substitute another org when the active org is ineligible", () => {
    expect(
      getActiveCloudShareOrgsForSession(
        "org-b",
        {
          session_id: "s1",
          orgId: buildCloudOrgSelectorValue("org-a"),
        },
        {},
        ORGS,
        sharedScopes,
        ["github.com/acme/alpha"]
      )
    ).toEqual([]);
  });
});
