import { describe, expect, it } from "vitest";

import type { ProjectOrg } from "@src/api/http/project";

import { canAdministerProjectOrg } from "./useProjectOrgCloudPermissions";

const localOrg: ProjectOrg = {
  id: "local-org",
  name: "Team",
  slug: "team",
  org_key: "team",
  source: "local",
  sync_provider: "orgii_collab",
  external_org_id: "cloud-org",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

const loaded = { projectOrgsLoaded: true, cloudRosterPending: false };

describe("canAdministerProjectOrg", () => {
  it.each([
    ["owner", true],
    ["admin", true],
    ["member", false],
  ])("maps the direct cloud %s role", (role, expected) => {
    expect(
      canAdministerProjectOrg(
        "cloud-org",
        [],
        [{ orgId: "cloud-org", name: "Team", role }],
        loaded
      )
    ).toBe(expected);
  });

  it("resolves a local project-org alias to the cloud role", () => {
    expect(
      canAdministerProjectOrg(
        localOrg.id,
        [localOrg],
        [{ orgId: "cloud-org", name: "Team", role: "member" }],
        loaded
      )
    ).toBe(false);
  });

  it("does not apply cloud role restrictions to an ordinary local org", () => {
    expect(
      canAdministerProjectOrg(
        "personal",
        [
          {
            ...localOrg,
            id: "personal",
            sync_provider: "local",
            external_org_id: undefined,
          },
        ],
        [],
        loaded
      )
    ).toBe(true);
  });

  it("fails closed while aliases or a signed-in cloud roster are pending", () => {
    expect(
      canAdministerProjectOrg("local-org", [], [], {
        projectOrgsLoaded: false,
        cloudRosterPending: false,
      })
    ).toBe(false);
    expect(
      canAdministerProjectOrg("local-org", [localOrg], [], {
        projectOrgsLoaded: true,
        cloudRosterPending: true,
      })
    ).toBe(false);
  });
});
