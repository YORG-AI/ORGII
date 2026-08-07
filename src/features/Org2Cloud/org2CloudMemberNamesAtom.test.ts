import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createInstrumentedStore,
  getInstrumentedStore,
  isStoreInitialized,
} from "@src/util/core/state/instrumentedStore";

import { getFreshCloudAccessToken } from "./cloudShortId";
import { listOrgMembers } from "./org2CloudClient";
import {
  ensureCloudMemberNames,
  org2CloudMemberNamesAtom,
  resolveCloudMemberName,
} from "./org2CloudMemberNamesAtom";

vi.mock("./cloudShortId", () => ({
  getFreshCloudAccessToken: vi.fn(),
}));

vi.mock("./org2CloudClient", () => ({
  listOrgMembers: vi.fn(),
}));

const getTokenMock = vi.mocked(getFreshCloudAccessToken);
const listOrgMembersMock = vi.mocked(listOrgMembers);

beforeEach(() => {
  if (!isStoreInitialized()) createInstrumentedStore();
  getInstrumentedStore().set(org2CloudMemberNamesAtom, {});
  getTokenMock.mockResolvedValue("jwt-1");
  listOrgMembersMock.mockResolvedValue([
    {
      userId: "user-1",
      displayName: "Ada Lovelace",
      role: "member",
      status: "active",
    },
    { userId: "user-2", role: "member", status: "active" },
  ]);
});

afterEach(() => {
  getInstrumentedStore().set(org2CloudMemberNamesAtom, {});
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
    expect(listOrgMembersMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing when signed out", async () => {
    getTokenMock.mockResolvedValue(null);
    await ensureCloudMemberNames("corg-1");
    expect(listOrgMembersMock).not.toHaveBeenCalled();
    expect(getInstrumentedStore().get(org2CloudMemberNamesAtom)).toEqual({});
  });

  it("swallows roster fetch failures and leaves the cache empty for retry", async () => {
    listOrgMembersMock.mockRejectedValueOnce(new Error("network down"));
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
    expect(listOrgMembersMock).toHaveBeenCalledTimes(1);
  });
});
