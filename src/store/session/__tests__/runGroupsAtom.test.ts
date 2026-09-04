import { beforeEach, describe, expect, it } from "vitest";

import {
  createInstrumentedStore,
  getInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  removeRunGroupAtom,
  runGroupByIdAtom,
  runGroupsAtom,
} from "../runGroupsAtom";

beforeEach(() => {
  resetInstrumentedStore();
  createInstrumentedStore();
});

describe("removeRunGroupAtom", () => {
  it("drops the group's data", () => {
    const store = getInstrumentedStore();
    store.set(runGroupsAtom, {
      "group-1": { groupId: "group-1", entries: [] },
    } as never);

    store.set(removeRunGroupAtom, "group-1");

    expect(store.get(runGroupsAtom)["group-1"]).toBeUndefined();
  });

  it("releases the group's derived atom", () => {
    // The regression this guards: removing a group dropped its data but left
    // the per-id derived atom in the module cache, so the map grew with every
    // run group ever created.
    const store = getInstrumentedStore();
    const before = runGroupByIdAtom("group-1");

    store.set(removeRunGroupAtom, "group-1");

    expect(runGroupByIdAtom("group-1")).not.toBe(before);
  });

  it("keeps other groups' derived atoms", () => {
    const store = getInstrumentedStore();
    const other = runGroupByIdAtom("group-2");

    store.set(removeRunGroupAtom, "group-1");

    expect(runGroupByIdAtom("group-2")).toBe(other);
  });
});
