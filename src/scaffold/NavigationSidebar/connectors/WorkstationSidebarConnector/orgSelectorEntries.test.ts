import { describe, expect, it } from "vitest";

import {
  buildOrgSelectorEntries,
  resolveProjectOrgScopeId,
} from "@src/features/Organizations/orgSelectorEntries";

const PERSONAL = "personal-org";

const base = {
  personalOrgId: PERSONAL,
  personalLabel: "Personal",
  localSuffix: "local",
};

describe("buildOrgSelectorEntries", () => {
  it("lists personal first, then locals, then cloud roster entries", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "l1", name: "sdfdsf" }],
      cloudOrgs: [{ orgId: "c1", name: "Team" }],
    });
    expect(entries.map((entry) => entry.kind)).toEqual([
      "personal",
      "local",
      "cloud",
    ]);
    expect(entries[2]).toMatchObject({
      value: "cloud:c1",
      label: "Team",
      cloudOrgId: "c1",
    });
  });

  it("cloud entries come ONLY from the roster (no persisted-era survivors)", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [],
      cloudOrgs: [{ orgId: "live", name: "Live org" }],
    });
    expect(entries.filter((entry) => entry.kind === "cloud")).toHaveLength(1);
  });

  it("hides a local row whose OWN id is a live cloud org id (pre-alias era duplicate)", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "e0e22b9d", name: "vinceorz's workspace" }],
      cloudOrgs: [{ orgId: "e0e22b9d", name: "vinceorz's workspace" }],
    });
    expect(entries.map((entry) => entry.value)).toEqual([
      PERSONAL,
      "cloud:e0e22b9d",
    ]);
  });

  it("hides an aliased local row once the roster has loaded and the alias is dead", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "l1", name: "old org", external_org_id: "dead-org" }],
      cloudOrgs: [{ orgId: "live", name: "Live org" }],
    });
    expect(entries.map((entry) => entry.value)).toEqual([
      PERSONAL,
      "cloud:live",
    ]);
  });

  it("hides an aliased local row while signed out or the roster is unknown", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "l1", name: "old org", external_org_id: "dead-org" }],
      cloudOrgs: [],
    });
    expect(entries.map((entry) => entry.value)).toEqual([PERSONAL]);
  });

  it("hides an aliased row of a LOADED cloud org even before the loaded flag lands", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "l1", name: "Team", external_org_id: "c1" }],
      cloudOrgs: [{ orgId: "c1", name: "Team" }],
    });
    expect(entries.map((entry) => entry.value)).toEqual([PERSONAL, "cloud:c1"]);
  });

  it("suffixes a local org that shares its name with a cloud org", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [{ id: "l1", name: "vinceorz's workspace" }],
      cloudOrgs: [{ orgId: "c1", name: "vinceorz's workspace" }],
    });
    expect(entries[1].label).toBe("vinceorz's workspace · local");
    expect(entries[2].label).toBe("vinceorz's workspace");
  });

  it("suffixes duplicate cloud names with a short org id", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [],
      cloudOrgs: [
        { orgId: "aaaabbbb-1111", name: "Team" },
        { orgId: "ccccdddd-2222", name: "Team" },
      ],
    });
    expect(entries[1].label).toBe("Team · aaaabbbb");
    expect(entries[2].label).toBe("Team · ccccdddd");
  });

  it("keeps genuine local orgs untouched and deduplicates repeated local ids", () => {
    const entries = buildOrgSelectorEntries({
      ...base,
      localOrgs: [
        { id: "l1", name: "e2e-collab-test" },
        { id: "l1", name: "e2e-collab-test" },
        { id: PERSONAL, name: "Personal duplicate" },
      ],
      cloudOrgs: [{ orgId: "c1", name: "Team" }],
    });
    expect(entries.map((entry) => entry.value)).toEqual([
      PERSONAL,
      "l1",
      "cloud:c1",
    ]);
    expect(entries[1].label).toBe("e2e-collab-test");
  });
});

describe("resolveProjectOrgScopeId", () => {
  it("keeps personal and genuine local scopes unchanged", () => {
    expect(resolveProjectOrgScopeId(PERSONAL, [])).toBe(PERSONAL);
    expect(resolveProjectOrgScopeId("local-1", [])).toBe("local-1");
  });

  it("maps a cloud scope to its durable local alias", () => {
    expect(
      resolveProjectOrgScopeId("cloud:cloud-1", [
        { id: "local-alias-1", name: "Team", external_org_id: "cloud-1" },
      ])
    ).toBe("local-alias-1");
  });

  it("supports pre-alias cloud-id rows and an alias that has not loaded yet", () => {
    expect(
      resolveProjectOrgScopeId("cloud:cloud-1", [
        { id: "cloud-1", name: "Team" },
      ])
    ).toBe("cloud-1");
    expect(resolveProjectOrgScopeId("cloud:cloud-2", [])).toBe("cloud-2");
  });
});
