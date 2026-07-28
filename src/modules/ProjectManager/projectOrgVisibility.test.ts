import { describe, expect, it } from "vitest";

import type { ProjectOrg } from "@src/api/http/project";

import {
  canDeleteLocalProjectOrg,
  filterSelectableProjectOrgs,
} from "./projectOrgVisibility";

function projectOrg(
  id: string,
  overrides: Partial<ProjectOrg> = {}
): ProjectOrg {
  return {
    id,
    name: id,
    slug: id,
    org_key: id.toUpperCase(),
    source: "local",
    sync_provider: "none",
    created_at: "2026-07-20T00:00:00.000Z",
    updated_at: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

describe("filterSelectableProjectOrgs", () => {
  it("keeps plain local orgs and active managed-cloud aliases", () => {
    const local = projectOrg("local");
    const activeCloud = projectOrg("cloud-alias", {
      source: "collab",
      sync_provider: "orgii_collab",
      external_org_id: "cloud-1",
    });

    expect(
      filterSelectableProjectOrgs(
        [local, activeCloud],
        [{ orgId: "cloud-1", name: "Team", role: "member" }]
      )
    ).toEqual([local, activeCloud]);
  });

  it("hides a managed-cloud alias absent from the authoritative roster", () => {
    const revokedCloud = projectOrg("cloud-alias", {
      source: "collab",
      sync_provider: "orgii_collab",
      external_org_id: "removed-cloud",
    });

    expect(filterSelectableProjectOrgs([revokedCloud], [])).toEqual([]);
  });

  it("keeps a legacy self-hosted alias that has no managed external id", () => {
    const selfHosted = projectOrg("self-hosted", {
      source: "collab",
      sync_provider: "orgii_collab",
    });

    expect(filterSelectableProjectOrgs([selfHosted], [])).toEqual([selfHosted]);
  });
});

describe("canDeleteLocalProjectOrg", () => {
  it("allows a non-default local org", () => {
    expect(canDeleteLocalProjectOrg(projectOrg("local-team"))).toBe(true);
  });

  it("protects the default personal org", () => {
    expect(canDeleteLocalProjectOrg(projectOrg("personal-org"))).toBe(false);
  });

  it("rejects cloud and collab-backed aliases", () => {
    expect(
      canDeleteLocalProjectOrg(
        projectOrg("cloud", {
          source: "collab",
          sync_provider: "orgii_collab",
          external_org_id: "cloud-id",
        })
      )
    ).toBe(false);
    expect(
      canDeleteLocalProjectOrg(
        projectOrg("marked-local", { sync_provider: "orgii_collab" })
      )
    ).toBe(false);
  });
});
