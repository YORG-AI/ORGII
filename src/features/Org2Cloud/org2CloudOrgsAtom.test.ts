import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  beginOrg2CloudOrgsRequest,
  commitOrg2CloudOrgsRequest,
  getSidebarActiveCloudOrg,
  isOrg2CloudOrgsConverging,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
  queueOrg2CloudOrgsConvergence,
} from "./org2CloudOrgsAtom";

describe("org2 cloud roster request ordering", () => {
  it("resolves sharing controls only for the exact active cloud org", () => {
    const orgs = [
      { orgId: "alpha", name: "Alpha", role: "owner" },
      { orgId: "beta", name: "Beta", role: "member" },
    ];

    expect(getSidebarActiveCloudOrg(null, orgs)).toBeNull();
    expect(getSidebarActiveCloudOrg("missing", orgs)).toBeNull();
    expect(getSidebarActiveCloudOrg("beta", orgs)).toEqual(orgs[1]);
  });

  it("does not let an older realtime response overwrite a newer mutation refetch", () => {
    const store = createStore();
    const realtimeRead = beginOrg2CloudOrgsRequest(store);
    const mutationRead = beginOrg2CloudOrgsRequest(store);

    expect(
      commitOrg2CloudOrgsRequest(store, mutationRead, [
        { orgId: "personal", name: "Personal", role: "owner" },
        { orgId: "team", name: "Team", role: "member" },
      ])
    ).toBe(true);
    expect(
      commitOrg2CloudOrgsRequest(store, realtimeRead, [
        { orgId: "personal", name: "Personal", role: "owner" },
      ])
    ).toBe(false);

    expect(store.get(org2CloudOrgsAtom).map((org) => org.orgId)).toEqual([
      "personal",
      "team",
    ]);
    expect(store.get(org2CloudOrgsLoadedAtom)).toBe(true);
  });

  it("invalidates an in-flight roster read when auth is cleared", () => {
    const store = createStore();
    const staleRead = beginOrg2CloudOrgsRequest(store);
    beginOrg2CloudOrgsRequest(store);
    store.set(org2CloudOrgsAtom, []);
    store.set(org2CloudOrgsLoadedAtom, false);

    expect(
      commitOrg2CloudOrgsRequest(store, staleRead, [
        { orgId: "zombie", name: "Zombie", role: "owner" },
      ])
    ).toBe(false);
    expect(store.get(org2CloudOrgsAtom)).toEqual([]);
    expect(store.get(org2CloudOrgsLoadedAtom)).toBe(false);
  });

  it("serializes mutation convergence and exposes its priority window", async () => {
    const store = createStore();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];

    const first = queueOrg2CloudOrgsConvergence(store, async () => {
      order.push("first-start");
      await firstGate;
      order.push("first-end");
      return "first";
    });
    const second = queueOrg2CloudOrgsConvergence(store, async () => {
      order.push("second");
      return "second";
    });

    expect(isOrg2CloudOrgsConverging(store)).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "second",
    ]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(isOrg2CloudOrgsConverging(store)).toBe(false);
  });
});
