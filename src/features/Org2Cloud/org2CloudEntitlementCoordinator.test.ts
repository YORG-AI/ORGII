import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { org2CloudSharingFloorAtom } from "./org2CloudAccessSettings";
import { getEntitlementState } from "./org2CloudClient";
import {
  ENTITLEMENT_REFRESH_TTL_MS,
  __ENTITLEMENT_COORDINATOR_INTERNALS,
  refreshOrgEntitlement,
  resetOrgEntitlementCoordinator,
  seedOrgEntitlement,
} from "./org2CloudEntitlementCoordinator";

vi.mock("./org2CloudClient", () => ({
  getEntitlementState: vi.fn(),
}));

const getEntitlementStateMock = vi.mocked(getEntitlementState);

describe("refreshOrgEntitlement", () => {
  let store: ReturnType<typeof createStore>;
  const token = async () => "jwt-1";

  beforeEach(() => {
    vi.useFakeTimers();
    store = createStore();
    store.set(org2CloudSharingFloorAtom, {});
    getEntitlementStateMock.mockReset();
    getEntitlementStateMock.mockResolvedValue({
      orgSharingFloor: "metadata_only",
    } as never);
  });

  afterEach(() => {
    __ENTITLEMENT_COORDINATOR_INTERNALS.resetForStore(store);
    vi.useRealTimers();
  });

  it("writes the floor into the persisted mirror", async () => {
    await refreshOrgEntitlement(store, "corg-1", token);
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({
      "corg-1": "metadata_only",
    });
    expect(getEntitlementStateMock).toHaveBeenCalledWith("jwt-1", "corg-1");
  });

  it("single-flights concurrent refreshes for the same org", async () => {
    let release!: (value: { orgSharingFloor: string }) => void;
    getEntitlementStateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve as never;
        }) as never
    );

    const first = refreshOrgEntitlement(store, "corg-1", token);
    const second = refreshOrgEntitlement(store, "corg-1", token);
    for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    release({ orgSharingFloor: "full_replay" });
    await Promise.all([first, second]);

    expect(getEntitlementStateMock).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudSharingFloorAtom)["corg-1"]).toBe("full_replay");
  });

  it("TTL-gates repeat reads; force bypasses the TTL", async () => {
    await refreshOrgEntitlement(store, "corg-1", token);
    await refreshOrgEntitlement(store, "corg-1", token);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(1);

    await refreshOrgEntitlement(store, "corg-1", token, { force: true });
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(ENTITLEMENT_REFRESH_TTL_MS + 1);
    await refreshOrgEntitlement(store, "corg-1", token);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(3);
  });

  it("tracks orgs independently", async () => {
    await refreshOrgEntitlement(store, "corg-1", token);
    await refreshOrgEntitlement(store, "corg-2", token);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(2);
  });

  it("a null entitlement schedules exactly one bounded retry", async () => {
    getEntitlementStateMock.mockResolvedValueOnce(null as never);
    await refreshOrgEntitlement(store, "corg-1", token);
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({});
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(1);

    getEntitlementStateMock.mockResolvedValueOnce(null as never);
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_TTL_MS + 1);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_TTL_MS * 3);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(2);
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({});
  });

  it("a null token never reaches the entitlement RPC", async () => {
    await refreshOrgEntitlement(store, "corg-2", async () => null);
    expect(getEntitlementStateMock).not.toHaveBeenCalled();
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({});
  });

  it("drops a late response from the previous account or endpoint epoch", async () => {
    let release!: (value: { orgSharingFloor: string }) => void;
    getEntitlementStateMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve as never;
        }) as never
    );
    const stale = refreshOrgEntitlement(store, "corg-1", token);
    for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    resetOrgEntitlementCoordinator(store);
    release({ orgSharingFloor: "full_replay" });
    await stale;
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({});
  });

  it("cancels the trailing retry when identity resets", async () => {
    getEntitlementStateMock.mockResolvedValueOnce(null as never);
    await refreshOrgEntitlement(store, "corg-1", token);
    resetOrgEntitlementCoordinator(store);
    await vi.advanceTimersByTimeAsync(ENTITLEMENT_REFRESH_TTL_MS * 2);
    expect(getEntitlementStateMock).toHaveBeenCalledTimes(1);
  });
});

describe("seedOrgEntitlement", () => {
  let store: ReturnType<typeof createStore>;
  const token = async () => "jwt-1";

  beforeEach(() => {
    store = createStore();
    store.set(org2CloudSharingFloorAtom, {});
    getEntitlementStateMock.mockReset();
    __ENTITLEMENT_COORDINATOR_INTERNALS.resetForStore(store);
  });

  it("writes the floor mirror without any RPC", () => {
    seedOrgEntitlement(store, "corg-1", {
      plan: "pro",
      status: "active",
      orgSharingFloor: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
    });
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({
      "corg-1": COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
    });
    expect(getEntitlementStateMock).not.toHaveBeenCalled();
  });

  it("defaults a missing floor to off", () => {
    seedOrgEntitlement(store, "corg-1", { plan: "free", status: "active" });
    expect(store.get(org2CloudSharingFloorAtom)).toEqual({
      "corg-1": COLLAB_SESSION_ACCESS_MODE.OFF,
    });
  });

  it("stamps the TTL window so an immediate refresh is coalesced", async () => {
    seedOrgEntitlement(store, "corg-1", {
      plan: "pro",
      status: "active",
      orgSharingFloor: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
    });
    await refreshOrgEntitlement(store, "corg-1", token);
    expect(getEntitlementStateMock).not.toHaveBeenCalled();
  });
});
