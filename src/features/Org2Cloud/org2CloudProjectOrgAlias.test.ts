import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";
import type { ProjectOrg } from "@src/api/http/project";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";
import {
  ensureProjectOrgForCloudOrg,
  resolveCloudOrgForProjectOrg,
} from "./org2CloudProjectOrgAlias";

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readOrgs: vi.fn(),
    createOrg: vi.fn(),
    configureOrgCollabSync: vi.fn(),
  },
}));

const projectApiMock = vi.mocked(projectApi);

const CLOUD_ORG = { orgId: "corg-1", name: "Cloud Team" };

function makeProjectOrg(overrides: Partial<ProjectOrg> = {}): ProjectOrg {
  return {
    id: "porg-1",
    name: "Cloud Team",
    slug: "cloud-team",
    org_key: "cloud-team",
    source: "local",
    sync_provider: "none",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudOrgsAtom, []);
  projectApiMock.readOrgs.mockResolvedValue([]);
  // configureOrgCollabSync echoes the marked org (what the Rust command does).
  projectApiMock.configureOrgCollabSync.mockImplementation(async (input) =>
    makeProjectOrg({
      id: input.orgId,
      sync_provider: "orgii_collab",
      external_org_id: input.externalOrgId,
    })
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("ensureProjectOrgForCloudOrg", () => {
  it("returns an already-marked alias unchanged (idempotent)", async () => {
    const alias = makeProjectOrg({
      sync_provider: "orgii_collab",
      external_org_id: "corg-1",
    });
    projectApiMock.readOrgs.mockResolvedValue([alias]);

    await expect(ensureProjectOrgForCloudOrg(CLOUD_ORG)).resolves.toBe(alias);
    expect(projectApiMock.createOrg).not.toHaveBeenCalled();
    expect(projectApiMock.configureOrgCollabSync).not.toHaveBeenCalled();
  });

  it("marks an id-matched local org and records the external org id", async () => {
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({ id: "corg-1", name: "Something Else" }),
    ]);

    const result = await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledWith({
      orgId: "corg-1",
      externalOrgId: "corg-1",
    });
    expect(result.sync_provider).toBe("orgii_collab");
    expect(projectApiMock.createOrg).not.toHaveBeenCalled();
  });

  it("adopts a name-matched UNALIASED local org", async () => {
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({ id: "local-7", name: "Cloud Team" }),
    ]);

    await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledWith({
      orgId: "local-7",
      externalOrgId: "corg-1",
    });
  });

  it("re-stamps an id-matched alias that is marked but missing external_org_id", async () => {
    // Legacy state: the Rust pull-path heal (ensure_collab_project_org) set
    // sync_provider but never stamps external_org_id. Without the re-stamp,
    // resolveCloudOrgForProjectOrg returns null forever and the lock /
    // short-id planes silently never engage while the engine keeps syncing.
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({
        id: "corg-1",
        name: "Cloud Team",
        sync_provider: "orgii_collab",
      }),
    ]);

    const result = await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledWith({
      orgId: "corg-1",
      externalOrgId: "corg-1",
    });
    expect(result.external_org_id).toBe("corg-1");
    expect(projectApiMock.createOrg).not.toHaveBeenCalled();
  });

  it("never steals a name-matched org aliased to a DIFFERENT external org", async () => {
    // A self-hosted collab org with the same display name: adopting it would
    // drain one outbox into two backends.
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({
        id: "local-7",
        name: "Cloud Team",
        sync_provider: "orgii_collab",
        external_org_id: "selfhosted-1",
      }),
    ]);
    projectApiMock.createOrg.mockResolvedValue(
      makeProjectOrg({ id: "corg-1" })
    );

    await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.createOrg).toHaveBeenCalledWith({
      name: "Cloud Team",
      id: "corg-1",
    });
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledWith({
      orgId: "corg-1",
      externalOrgId: "corg-1",
    });
  });

  it("never adopts a name-matched org already marked orgii_collab, even without an external org id", async () => {
    // A stamp-less legacy self-hosted alias (marked by the Rust heal, which
    // sets only the provider flag): adopting it by name would drain ONE
    // outbox into TWO backends — self-hosted engine + cloud engine.
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({
        id: "local-7",
        name: "Cloud Team",
        sync_provider: "orgii_collab",
      }),
    ]);
    projectApiMock.createOrg.mockResolvedValue(
      makeProjectOrg({ id: "corg-1" })
    );

    await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.createOrg).toHaveBeenCalledWith({
      name: "Cloud Team",
      id: "corg-1",
    });
    // The self-hosted row is left untouched; only the fresh row is stamped.
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledTimes(1);
    expect(projectApiMock.configureOrgCollabSync).toHaveBeenCalledWith({
      orgId: "corg-1",
      externalOrgId: "corg-1",
    });
  });

  it("creates the alias row keyed by the cloud org id when nothing matches", async () => {
    projectApiMock.createOrg.mockResolvedValue(
      makeProjectOrg({ id: "corg-1" })
    );

    const result = await ensureProjectOrgForCloudOrg(CLOUD_ORG);
    expect(projectApiMock.createOrg).toHaveBeenCalledWith({
      name: "Cloud Team",
      id: "corg-1",
    });
    expect(result.external_org_id).toBe("corg-1");
  });
});

describe("resolveCloudOrgForProjectOrg", () => {
  const CLOUD_ALIAS = makeProjectOrg({
    id: "porg-1",
    sync_provider: "orgii_collab",
    external_org_id: "corg-1",
  });

  it("resolves a cloud-aliased project org to its cloud org id", async () => {
    projectApiMock.readOrgs.mockResolvedValue([CLOUD_ALIAS]);
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);

    await expect(resolveCloudOrgForProjectOrg("porg-1")).resolves.toBe(
      "corg-1"
    );
  });

  it("returns null for a purely local project org", async () => {
    projectApiMock.readOrgs.mockResolvedValue([makeProjectOrg()]);
    await expect(resolveCloudOrgForProjectOrg("porg-1")).resolves.toBeNull();
  });

  it("returns null for a SELF-HOSTED collab alias (same provider flag, foreign external id)", async () => {
    projectApiMock.readOrgs.mockResolvedValue([
      makeProjectOrg({
        sync_provider: "orgii_collab",
        external_org_id: "selfhosted-1",
      }),
    ]);
    getInstrumentedStore().set(org2CloudOrgsAtom, [
      { orgId: "corg-1", name: "Cloud Team", role: "member" },
    ]);

    await expect(resolveCloudOrgForProjectOrg("porg-1")).resolves.toBeNull();
  });

  it("returns null while signed out (cloud orgs atom empty)", async () => {
    projectApiMock.readOrgs.mockResolvedValue([CLOUD_ALIAS]);
    await expect(resolveCloudOrgForProjectOrg("porg-1")).resolves.toBeNull();
  });

  it("returns null for an unknown project org", async () => {
    await expect(resolveCloudOrgForProjectOrg("nope")).resolves.toBeNull();
  });
});
