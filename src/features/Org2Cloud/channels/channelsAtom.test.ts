import { createStore } from "jotai/vanilla";
import { describe, expect, it } from "vitest";

import {
  bumpOrg2CloudChannelsVersionAtom,
  org2CloudChannelsVersionAtom,
} from "./channelsAtom";

describe("bumpOrg2CloudChannelsVersionAtom", () => {
  it("increments per-org counters independently, preserving other orgs", () => {
    const store = createStore();
    expect(store.get(org2CloudChannelsVersionAtom)).toEqual({});

    store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    expect(store.get(org2CloudChannelsVersionAtom)).toEqual({ "org-a": 1 });

    store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    store.set(bumpOrg2CloudChannelsVersionAtom, "org-b");
    expect(store.get(org2CloudChannelsVersionAtom)).toEqual({
      "org-a": 2,
      "org-b": 1,
    });

    // A bump for one org must never disturb another org's counter.
    store.set(bumpOrg2CloudChannelsVersionAtom, "org-b");
    expect(store.get(org2CloudChannelsVersionAtom)["org-a"]).toBe(2);
    expect(store.get(org2CloudChannelsVersionAtom)["org-b"]).toBe(2);
  });

  it("produces a new object per bump so atom subscribers re-evaluate", () => {
    const store = createStore();
    store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    const first = store.get(org2CloudChannelsVersionAtom);
    store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    const second = store.get(org2CloudChannelsVersionAtom);
    expect(second).not.toBe(first);
    expect(first).toEqual({ "org-a": 1 });
    expect(second).toEqual({ "org-a": 2 });
  });
});
