import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  buildCloudSessionShareLink,
  parseCloudShareInput,
} from "./org2CloudOrgManagement";
import {
  type Org2CloudPendingShare,
  consumeOrg2CloudPendingShareAtom,
  org2CloudPendingShareAtom,
} from "./org2CloudPendingShareAtom";

const SHARE: Org2CloudPendingShare = { shareToken: "a".repeat(64) };

describe("org2CloudPendingShareAtom one-shot semantics", () => {
  it("returns the pending share exactly once and clears it", () => {
    const store = createStore();
    store.set(org2CloudPendingShareAtom, SHARE);

    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual(SHARE);
    expect(store.get(org2CloudPendingShareAtom)).toBeNull();
    // Second consumer (or a re-render) must not replay the import.
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toBeNull();
  });

  it("returns null when nothing is pending", () => {
    const store = createStore();
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toBeNull();
    expect(store.get(org2CloudPendingShareAtom)).toBeNull();
  });

  it("a newer share replaces an unconsumed one wholesale", () => {
    const store = createStore();
    store.set(org2CloudPendingShareAtom, SHARE);
    const newer: Org2CloudPendingShare = { shareToken: "b".repeat(64) };
    store.set(org2CloudPendingShareAtom, newer);
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual(newer);
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toBeNull();
  });
});

describe("ImportSharedSessionDialog submit seam (parse → pending atom)", () => {
  it("a pasted share link lands on the atom for CloudShareImportDialog", () => {
    const token = "c".repeat(64);
    const parsed = parseCloudShareInput(buildCloudSessionShareLink(token));
    expect(parsed).toEqual({ shareToken: token });

    const store = createStore();
    store.set(org2CloudPendingShareAtom, parsed);
    expect(store.get(org2CloudPendingShareAtom)).toEqual({
      shareToken: token,
    });
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual({
      shareToken: token,
    });
  });
});
