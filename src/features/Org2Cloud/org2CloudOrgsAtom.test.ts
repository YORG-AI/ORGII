// @vitest-environment jsdom
import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginOrg2CloudOrgsRequest,
  commitOrg2CloudOrgsRequest,
  failOrg2CloudOrgsRequest,
  getSidebarActiveCloudOrg,
  isOrg2CloudOrgsConverging,
  markOrg2CloudOrgsRequestRetrying,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadStateAtom,
  org2CloudOrgsLoadedAtom,
  queueOrg2CloudOrgsConvergence,
  scheduleVisibleOrg2CloudOrgsRetry,
} from "./org2CloudOrgsAtom";

afterEach(() => {
  vi.useRealTimers();
});

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
    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("ready");
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

  it("exposes retrying and terminal failure without authorizing an empty roster", () => {
    const store = createStore();
    const request = beginOrg2CloudOrgsRequest(store);

    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("loading");
    expect(markOrg2CloudOrgsRequestRetrying(store, request)).toBe(true);
    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("retrying");
    expect(failOrg2CloudOrgsRequest(store, request)).toBe(true);
    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("error");
    expect(store.get(org2CloudOrgsLoadedAtom)).toBe(false);
    expect(store.get(org2CloudOrgsAtom)).toEqual([]);
  });

  it("does not let a stale failure overwrite a newer successful roster", () => {
    const store = createStore();
    const staleRequest = beginOrg2CloudOrgsRequest(store);
    const currentRequest = beginOrg2CloudOrgsRequest(store);

    commitOrg2CloudOrgsRequest(store, currentRequest, [
      { orgId: "team", name: "Team", role: "member" },
    ]);

    expect(failOrg2CloudOrgsRequest(store, staleRequest)).toBe(false);
    expect(store.get(org2CloudOrgsLoadStateAtom)).toBe("ready");
    expect(store.get(org2CloudOrgsAtom)).toHaveLength(1);
  });

  it("pauses a first-load retry while hidden and revalidates once on return", () => {
    vi.useFakeTimers();
    let visibilityState: DocumentVisibilityState = "hidden";
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState"
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    const retry = vi.fn();

    const dispose = scheduleVisibleOrg2CloudOrgsRetry(2_000, retry);
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(retry).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledTimes(1);

    dispose();
    if (originalDescriptor) {
      Object.defineProperty(document, "visibilityState", originalDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
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
