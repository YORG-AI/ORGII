import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  buildCloudSessionShareLink,
  parseCloudShareInput,
} from "./org2CloudOrgManagement";
import {
  consumeOrg2CloudPendingShareAtom,
  org2CloudPendingShareAtom,
  queueOrg2CloudPendingShareAtom,
} from "./org2CloudPendingShareAtom";

const SHARE = {
  shareToken: "a".repeat(64),
  endpoint: { kind: "official" as const },
};

describe("org2CloudPendingShareAtom one-shot semantics", () => {
  it("returns the pending share exactly once and clears it", () => {
    const store = createStore();
    const queued = store.set(queueOrg2CloudPendingShareAtom, SHARE);

    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual(queued);
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
    store.set(queueOrg2CloudPendingShareAtom, SHARE);
    const newer = {
      shareToken: "b".repeat(64),
      endpoint: { kind: "official" as const },
    };
    const queued = store.set(queueOrg2CloudPendingShareAtom, newer);
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual(queued);
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toBeNull();
  });

  it("gives repeated opens of the same token distinct attempt ids", () => {
    const store = createStore();
    const first = store.set(queueOrg2CloudPendingShareAtom, SHARE);
    store.set(consumeOrg2CloudPendingShareAtom);
    const second = store.set(queueOrg2CloudPendingShareAtom, SHARE);
    expect(second.shareToken).toBe(first.shareToken);
    expect(second.attemptId).toBe(first.attemptId + 1);
  });
});

describe("ImportSharedSessionDialog submit seam (parse → pending atom)", () => {
  it("a pasted share link lands on the atom for CloudShareImportDialog", () => {
    const token = "c".repeat(64);
    const parsed = parseCloudShareInput(buildCloudSessionShareLink(token));
    expect(parsed).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
    });

    const store = createStore();
    if (!parsed) throw new Error("expected parsed share");
    const queued = store.set(queueOrg2CloudPendingShareAtom, parsed);
    expect(store.get(org2CloudPendingShareAtom)).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
      attemptId: queued.attemptId,
    });
    expect(store.set(consumeOrg2CloudPendingShareAtom)).toEqual({
      shareToken: token,
      endpoint: { kind: "official" },
      attemptId: queued.attemptId,
    });
  });
});
