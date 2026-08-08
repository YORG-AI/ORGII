import { describe, expect, it } from "vitest";

import {
  getRetainedIssueDetailScopeCount,
  retainWorkstationIssueDetailScope,
  workstationSelectedIssueAtomFamily,
} from "./workstationIssueAtom";

describe("workstation issue detail retention", () => {
  it("ref-counts mounted consumers and evicts the atom on final release", () => {
    const scope = "issue-retention-test";
    const initialAtom = workstationSelectedIssueAtomFamily(scope);
    const releaseFirst = retainWorkstationIssueDetailScope(scope);
    const releaseSecond = retainWorkstationIssueDetailScope(scope);

    expect(getRetainedIssueDetailScopeCount()).toBeGreaterThanOrEqual(1);
    releaseFirst();
    expect(workstationSelectedIssueAtomFamily(scope)).toBe(initialAtom);

    releaseSecond();
    expect(workstationSelectedIssueAtomFamily(scope)).not.toBe(initialAtom);
  });

  it("can preserve a repo selection while still releasing its retention entry", () => {
    const scope = "repo-selection-retention-test";
    const initialAtom = workstationSelectedIssueAtomFamily(scope);
    const release = retainWorkstationIssueDetailScope(scope, {
      evictOnFinalRelease: false,
    });

    expect(release()).toBe(true);
    expect(workstationSelectedIssueAtomFamily(scope)).toBe(initialAtom);
  });
});
