import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";
import {
  MAX_CLOUD_MEMBER_NAME_ORGS,
  ensureCloudMemberNames,
  org2CloudMemberNamesAtom,
  resolveCloudMemberName,
} from "./org2CloudMemberNamesAtom";
import { loadCloudOrgMembers } from "./org2CloudMembersCoordinator";
import { org2CloudRosterVersionAtom } from "./org2CloudOrgsAtom";

vi.mock("./org2CloudMembersCoordinator", () => ({
  loadCloudOrgMembers: vi.fn(),
}));

const loadCloudOrgMembersMock = vi.mocked(loadCloudOrgMembers);

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://cloud.example.com",
  supabaseAnonKey: "anon",
  userId: "viewer-1",
  accessToken: "jwt-1",
  refreshToken: "refresh-1",
  expiresAt: 9999999999,
};

beforeEach(() => {
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudMemberNamesAtom, {});
  getInstrumentedStore().set(org2CloudAuthAtom, AUTH);
  getInstrumentedStore().set(org2CloudRosterVersionAtom, {});
  loadCloudOrgMembersMock.mockResolvedValue({
    auth: AUTH,
    members: [
      {
        userId: "user-1",
        displayName: "Ada Lovelace",
        role: "member",
        status: "active",
      },
      { userId: "user-2", role: "member", status: "active" },
    ],
  });
});

afterEach(() => {
  getInstrumentedStore().set(org2CloudMemberNamesAtom, {});
  getInstrumentedStore().set(org2CloudAuthAtom, null);
  getInstrumentedStore().set(org2CloudRosterVersionAtom, {});
  vi.clearAllMocks();
});

describe("ensureCloudMemberNames", () => {
  it("loads the roster once and caches display names by userId", async () => {
    await ensureCloudMemberNames("corg-1");
    const names = getInstrumentedStore().get(org2CloudMemberNamesAtom);
    expect(resolveCloudMemberName(names, "corg-1", "user-1")).toBe(
      "Ada Lovelace"
    );
    expect(resolveCloudMemberName(names, "corg-1", "user-2")).toBeNull();
    expect(resolveCloudMemberName(names, "corg-1", "user-gone")).toBeNull();

    await ensureCloudMemberNames("corg-1");
    expect(loadCloudOrgMembersMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when signed out", async () => {
    getInstrumentedStore().set(org2CloudAuthAtom, null);
    await ensureCloudMemberNames("corg-1");
    expect(loadCloudOrgMembersMock).not.toHaveBeenCalled();
    expect(getInstrumentedStore().get(org2CloudMemberNamesAtom)).toEqual({});
  });

  it("swallows roster fetch failures and leaves the cache empty for retry", async () => {
    loadCloudOrgMembersMock.mockRejectedValueOnce(new Error("network down"));
    await ensureCloudMemberNames("corg-1");
    expect(getInstrumentedStore().get(org2CloudMemberNamesAtom)).toEqual({});

    await ensureCloudMemberNames("corg-1");
    const names = getInstrumentedStore().get(org2CloudMemberNamesAtom);
    expect(resolveCloudMemberName(names, "corg-1", "user-1")).toBe(
      "Ada Lovelace"
    );
  });

  it("coalesces concurrent loads for the same org", async () => {
    await Promise.all([
      ensureCloudMemberNames("corg-1"),
      ensureCloudMemberNames("corg-1"),
    ]);
    expect(loadCloudOrgMembersMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an older roster completion after a version bump", async () => {
    let resolveOld!: (
      value: Awaited<ReturnType<typeof loadCloudOrgMembers>>
    ) => void;
    loadCloudOrgMembersMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce({
        auth: AUTH,
        members: [
          {
            userId: "user-1",
            displayName: "Current Name",
            role: "member",
            status: "active",
          },
        ],
      });

    const oldRequest = ensureCloudMemberNames("corg-1");
    await vi.waitFor(() =>
      expect(loadCloudOrgMembersMock).toHaveBeenCalledTimes(1)
    );
    getInstrumentedStore().set(org2CloudRosterVersionAtom, { "corg-1": 1 });
    await ensureCloudMemberNames("corg-1");
    resolveOld({
      auth: AUTH,
      members: [
        {
          userId: "user-1",
          displayName: "Stale Name",
          role: "member",
          status: "active",
        },
      ],
    });
    await oldRequest;

    const names = getInstrumentedStore().get(org2CloudMemberNamesAtom);
    expect(resolveCloudMemberName(names, "corg-1", "user-1")).toBe(
      "Current Name"
    );
  });

  it("bounds names retained across many orgs", async () => {
    for (let index = 0; index <= MAX_CLOUD_MEMBER_NAME_ORGS; index += 1) {
      await ensureCloudMemberNames(`corg-${index}`);
    }
    const names = getInstrumentedStore().get(org2CloudMemberNamesAtom);
    expect(Object.keys(names)).toHaveLength(MAX_CLOUD_MEMBER_NAME_ORGS);
    expect(names["corg-0"]).toBeUndefined();
    expect(names[`corg-${MAX_CLOUD_MEMBER_NAME_ORGS}`]).toBeDefined();
  });
});
