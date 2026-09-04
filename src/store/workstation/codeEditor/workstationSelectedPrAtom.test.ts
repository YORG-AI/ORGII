import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_RETAINED_PR_DETAIL_SCOPES,
  __resetRetainedPrDetailScopes,
  retainWorkstationPrDetailScope,
  workstationPrDetailCallbackAtomFamily,
  workstationPrDetailTabAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "./workstationSelectedPrAtom";

const scope = (prNumber: number) =>
  workstationPrScopeKey("repo-1", "/repo", prNumber);

beforeEach(() => {
  __resetRetainedPrDetailScopes();
});

describe("workstationPrScopeKey", () => {
  it("separates PRs within one repo", () => {
    expect(scope(1)).not.toBe(scope(2));
  });
});

describe("retainWorkstationPrDetailScope", () => {
  it("releases the atoms of scopes pushed out of the window", () => {
    // The regression this guards: these families are keyed per repo AND PR
    // number, and jotai-family pins every key forever, so one set of atoms
    // leaked per pull request the user had ever opened.
    const first = scope(0);
    const firstAtoms = [
      workstationSelectedPrAtomFamily(first),
      workstationPrDetailTabAtomFamily(first),
      workstationPrDetailCallbackAtomFamily(first),
    ];

    for (let index = 0; index <= MAX_RETAINED_PR_DETAIL_SCOPES; index += 1) {
      retainWorkstationPrDetailScope(scope(index));
    }

    // A family hands back a NEW atom instance for a key it has released.
    expect(workstationSelectedPrAtomFamily(first)).not.toBe(firstAtoms[0]);
    expect(workstationPrDetailTabAtomFamily(first)).not.toBe(firstAtoms[1]);
    expect(workstationPrDetailCallbackAtomFamily(first)).not.toBe(
      firstAtoms[2]
    );
  });

  it("keeps scopes that are still inside the window", () => {
    const kept = scope(MAX_RETAINED_PR_DETAIL_SCOPES);
    for (let index = 0; index <= MAX_RETAINED_PR_DETAIL_SCOPES; index += 1) {
      retainWorkstationPrDetailScope(scope(index));
    }
    const keptAtom = workstationSelectedPrAtomFamily(kept);
    retainWorkstationPrDetailScope(scope(MAX_RETAINED_PR_DETAIL_SCOPES + 1));

    expect(workstationSelectedPrAtomFamily(kept)).toBe(keptAtom);
  });

  it("re-retaining a scope keeps it out of the eviction slot", () => {
    for (let index = 0; index < MAX_RETAINED_PR_DETAIL_SCOPES; index += 1) {
      retainWorkstationPrDetailScope(scope(index));
    }
    const oldest = scope(0);
    // Revisiting the oldest PR should make the *second* oldest the victim.
    retainWorkstationPrDetailScope(oldest);
    const oldestAtom = workstationSelectedPrAtomFamily(oldest);
    retainWorkstationPrDetailScope(scope(999));

    expect(workstationSelectedPrAtomFamily(oldest)).toBe(oldestAtom);
  });
});
