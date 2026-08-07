import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";
import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import {
  allocateCloudAwareWorkItemId,
  getFreshCloudAccessToken,
  tryAllocateCloudWorkItemShortId,
} from "./cloudShortId";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { resolveCloudOrgForProjectOrg } from "./org2CloudProjectOrgAlias";
import { allocateWorkItemShortId } from "./org2CloudProjectsClient";

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readProject: vi.fn(),
    allocateWorkItemId: vi.fn(),
  },
}));

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: vi.fn(async (state: unknown) => state),
}));

vi.mock("./org2CloudProjectOrgAlias", () => ({
  resolveCloudOrgForProjectOrg: vi.fn(async () => null),
}));

vi.mock("./org2CloudProjectsClient", () => ({
  allocateWorkItemShortId: vi.fn(),
}));

const projectApiMock = vi.mocked(projectApi);
const ensureFreshSessionMock = vi.mocked(ensureFreshSession);
const resolveCloudOrgMock = vi.mocked(resolveCloudOrgForProjectOrg);
const allocateMock = vi.mocked(allocateWorkItemShortId);

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.co",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "jwt-1",
  refreshToken: "rt-1",
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
};

beforeEach(() => {
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudAuthAtom, AUTH);
  // Default: not cloud-aliased (mockResolvedValue overrides survive
  // clearAllMocks, so every test starts from the explicit default).
  resolveCloudOrgMock.mockResolvedValue(null);
});

afterEach(() => {
  getInstrumentedStore().set(org2CloudAuthAtom, null);
  vi.clearAllMocks();
});

describe("getFreshCloudAccessToken", () => {
  it("returns the fresh JWT and writes a refreshed session back to the atom", async () => {
    const refreshed = { ...AUTH, accessToken: "jwt-2" };
    ensureFreshSessionMock.mockResolvedValueOnce(refreshed);

    await expect(getFreshCloudAccessToken()).resolves.toBe("jwt-2");
    expect(getInstrumentedStore().get(org2CloudAuthAtom)).toBe(refreshed);
  });

  it("returns null when signed out or the refresh fails", async () => {
    getInstrumentedStore().set(org2CloudAuthAtom, null);
    await expect(getFreshCloudAccessToken()).resolves.toBeNull();

    getInstrumentedStore().set(org2CloudAuthAtom, AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(null);
    await expect(getFreshCloudAccessToken()).resolves.toBeNull();
  });
});

describe("tryAllocateCloudWorkItemShortId", () => {
  it("allocates through the cloud RPC for a cloud-aliased org", async () => {
    resolveCloudOrgMock.mockResolvedValue("corg-1");
    allocateMock.mockResolvedValue({ shortId: "SRV-7", n: 7 });

    await expect(
      tryAllocateCloudWorkItemShortId("porg-1", "project-1")
    ).resolves.toBe("SRV-7");
    expect(allocateMock).toHaveBeenCalledWith("jwt-1", "corg-1", "project-1");
  });

  it("returns null when the project org is not cloud-aliased", async () => {
    await expect(
      tryAllocateCloudWorkItemShortId("porg-1", "project-1")
    ).resolves.toBeNull();
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it("returns null while signed out (caller falls back to its own path)", async () => {
    resolveCloudOrgMock.mockResolvedValue("corg-1");
    getInstrumentedStore().set(org2CloudAuthAtom, null);

    await expect(
      tryAllocateCloudWorkItemShortId("porg-1", "project-1")
    ).resolves.toBeNull();
    expect(allocateMock).not.toHaveBeenCalled();
  });

  it("returns null when the server allocation fails (documented residual)", async () => {
    resolveCloudOrgMock.mockResolvedValue("corg-1");
    allocateMock.mockRejectedValue(new Error("offline"));

    await expect(
      tryAllocateCloudWorkItemShortId("porg-1", "project-1")
    ).resolves.toBeNull();
  });
});

describe("allocateCloudAwareWorkItemId", () => {
  beforeEach(() => {
    projectApiMock.readProject.mockResolvedValue({
      meta: { id: "project-1", org_id: "porg-1" },
    } as never);
    projectApiMock.allocateWorkItemId.mockResolvedValue("LOC-1");
  });

  it("uses the cloud allocator when the owning org is cloud-aliased", async () => {
    resolveCloudOrgMock.mockResolvedValue("corg-1");
    allocateMock.mockResolvedValue({ shortId: "SRV-9", n: 9 });

    await expect(allocateCloudAwareWorkItemId("proj-1")).resolves.toBe("SRV-9");
    expect(projectApiMock.allocateWorkItemId).not.toHaveBeenCalled();
  });

  it("falls back to the local counter for non-cloud orgs", async () => {
    await expect(allocateCloudAwareWorkItemId("proj-1")).resolves.toBe("LOC-1");
    expect(allocateMock).not.toHaveBeenCalled();
    expect(projectApiMock.allocateWorkItemId).toHaveBeenCalledWith("proj-1");
  });

  it("falls back to the local counter when the owning org cannot be read", async () => {
    projectApiMock.readProject.mockRejectedValue(new Error("ipc down"));
    await expect(allocateCloudAwareWorkItemId("proj-1")).resolves.toBe("LOC-1");
  });
});
