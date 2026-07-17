import { afterEach, describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";

import { getFreshCloudAccessToken } from "./cloudShortId";
import {
  acquireCloudWorkItemLock,
  releaseCloudWorkItemLock,
} from "./cloudWorkItemLock";
import { resolveCloudOrgForProjectOrg } from "./org2CloudProjectOrgAlias";
import {
  acquireWorkItemLock,
  releaseWorkItemLock,
} from "./org2CloudProjectsClient";

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readProject: vi.fn(async () => ({
      meta: { id: "project-1", org_id: "porg-1" },
    })),
  },
}));

vi.mock("./cloudShortId", () => ({
  getFreshCloudAccessToken: vi.fn(async () => "jwt-1"),
}));

vi.mock("./org2CloudProjectOrgAlias", () => ({
  resolveCloudOrgForProjectOrg: vi.fn(async () => "corg-1"),
}));

vi.mock("./org2CloudProjectsClient", () => ({
  acquireWorkItemLock: vi.fn(async () => 3),
  releaseWorkItemLock: vi.fn(async () => 4),
}));

const readProjectMock = vi.mocked(projectApi.readProject);
const tokenMock = vi.mocked(getFreshCloudAccessToken);
const resolveCloudOrgMock = vi.mocked(resolveCloudOrgForProjectOrg);
const acquireMock = vi.mocked(acquireWorkItemLock);
const releaseMock = vi.mocked(releaseWorkItemLock);

afterEach(() => {
  vi.clearAllMocks();
});

describe("acquireCloudWorkItemLock", () => {
  it("acquires through the cloud RPC for a cloud-aliased work item", async () => {
    await expect(
      acquireCloudWorkItemLock("proj", "w-1", { activeShortId: "AAA-1" })
    ).resolves.toBe(true);
    expect(resolveCloudOrgMock).toHaveBeenCalledWith("porg-1");
    expect(acquireMock).toHaveBeenCalledWith("jwt-1", "corg-1", "w-1", {
      activeShortId: "AAA-1",
    });
  });

  it("resolves false when the org is not cloud-aliased (caller falls through)", async () => {
    resolveCloudOrgMock.mockResolvedValueOnce(null);
    await expect(acquireCloudWorkItemLock("proj", "w-1")).resolves.toBe(false);
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("resolves false when signed out (proceed-without-arbitration residual)", async () => {
    tokenMock.mockResolvedValueOnce(null);
    await expect(acquireCloudWorkItemLock("proj", "w-1")).resolves.toBe(false);
    expect(acquireMock).not.toHaveBeenCalled();
  });

  it("propagates ORG2_CONFLICT so the orchestrator surfaces the holder", async () => {
    acquireMock.mockRejectedValueOnce(new Error("ORG2_CONFLICT"));
    await expect(acquireCloudWorkItemLock("proj", "w-1")).rejects.toThrow(
      "ORG2_CONFLICT"
    );
  });

  it("propagates a readProject failure (membership must stay provable)", async () => {
    readProjectMock.mockRejectedValueOnce(new Error("read failed"));
    await expect(acquireCloudWorkItemLock("proj", "w-1")).rejects.toThrow(
      "read failed"
    );
  });
});

describe("releaseCloudWorkItemLock", () => {
  it("releases through the cloud RPC and reports that it did", async () => {
    await expect(releaseCloudWorkItemLock("proj", "w-1")).resolves.toBe(true);
    expect(releaseMock).toHaveBeenCalledWith("jwt-1", "corg-1", "w-1");
  });

  it("is a no-op for non-cloud work items", async () => {
    resolveCloudOrgMock.mockResolvedValueOnce(null);
    await expect(releaseCloudWorkItemLock("proj", "w-1")).resolves.toBe(false);
    expect(releaseMock).not.toHaveBeenCalled();
  });
});
