import { beforeEach, describe, expect, it } from "vitest";

import { workstationIssueListAtomFamily } from "./workstationIssueAtom";
import {
  workstationAllOpenPrsAtomFamily,
  workstationPrAtomFamily,
  workstationPrCommitMessageAtomFamily,
  workstationRepoScopeKey,
} from "./workstationPrAtom";
import {
  MAX_WARM_RELEASED_REPO_SCOPES,
  __resetWorkstationRepoScopeRetention,
  getWorkstationRepoScopeRetentionStats,
  retainWorkstationRepoScope,
} from "./workstationRepoScopeRetention";

const scope = (index: number) =>
  workstationRepoScopeKey(`repo-${index}`, `/repos/${index}`);

function atomsFor(scopeKey: string) {
  return [
    workstationPrAtomFamily(scopeKey),
    workstationAllOpenPrsAtomFamily(scopeKey),
    workstationIssueListAtomFamily(scopeKey),
  ] as const;
}

function expectSameAtoms(scopeKey: string, atoms: ReturnType<typeof atomsFor>) {
  const current = atomsFor(scopeKey);
  expect(current[0]).toBe(atoms[0]);
  expect(current[1]).toBe(atoms[1]);
  expect(current[2]).toBe(atoms[2]);
}

function expectFreshAtoms(
  scopeKey: string,
  atoms: ReturnType<typeof atomsFor>
) {
  const current = atomsFor(scopeKey);
  expect(current[0]).not.toBe(atoms[0]);
  expect(current[1]).not.toBe(atoms[1]);
  expect(current[2]).not.toBe(atoms[2]);
}

beforeEach(() => {
  __resetWorkstationRepoScopeRetention();
});

describe("retainWorkstationRepoScope", () => {
  it("keeps a released scope warm so switching back is instant", () => {
    const key = scope(0);
    const atoms = atomsFor(key);
    const release = retainWorkstationRepoScope(key);
    release();

    expectSameAtoms(key, atoms);
    expect(getWorkstationRepoScopeRetentionStats()).toEqual({
      mounted: 0,
      warm: 1,
    });
  });

  it("evicts the least recently released scope past the warm window", () => {
    // The regression this guards: these families are keyed per repo scope and
    // jotai-family pins every key forever, so every repository ever opened kept
    // its PR and issue lists for the app lifetime.
    const oldest = scope(0);
    const oldestAtoms = atomsFor(oldest);
    for (let index = 0; index <= MAX_WARM_RELEASED_REPO_SCOPES; index += 1) {
      retainWorkstationRepoScope(scope(index))();
    }

    expectFreshAtoms(oldest, oldestAtoms);
    expectSameAtoms(scope(1), atomsFor(scope(1)));
    expect(getWorkstationRepoScopeRetentionStats().warm).toBe(
      MAX_WARM_RELEASED_REPO_SCOPES
    );
  });

  it("never releases a scope that still has a mounted consumer", () => {
    const mounted = scope(0);
    const mountedAtoms = atomsFor(mounted);
    const releaseFirst = retainWorkstationRepoScope(mounted);
    const releaseSecond = retainWorkstationRepoScope(mounted);
    releaseFirst();

    for (
      let index = 1;
      index <= MAX_WARM_RELEASED_REPO_SCOPES + 2;
      index += 1
    ) {
      retainWorkstationRepoScope(scope(index))();
    }

    expectSameAtoms(mounted, mountedAtoms);
    expect(getWorkstationRepoScopeRetentionStats().mounted).toBe(1);
    releaseSecond();
    expect(getWorkstationRepoScopeRetentionStats().mounted).toBe(0);
  });

  it("re-retaining a warm scope takes it out of the eviction order", () => {
    const revisited = scope(0);
    for (let index = 0; index < MAX_WARM_RELEASED_REPO_SCOPES; index += 1) {
      retainWorkstationRepoScope(scope(index))();
    }
    const release = retainWorkstationRepoScope(revisited);
    const revisitedAtoms = atomsFor(revisited);

    retainWorkstationRepoScope(scope(100))();
    retainWorkstationRepoScope(scope(101))();

    expectSameAtoms(revisited, revisitedAtoms);
    release();
    expectSameAtoms(revisited, revisitedAtoms);
  });

  it("ignores a second call of the same release", () => {
    const key = scope(0);
    const release = retainWorkstationRepoScope(key);
    const keepMounted = retainWorkstationRepoScope(key);
    release();
    release();

    expect(getWorkstationRepoScopeRetentionStats()).toEqual({
      mounted: 1,
      warm: 0,
    });
    keepMounted();
  });

  it("leaves the commit-message draft atom alone when evicting", () => {
    const evicted = scope(0);
    const draftAtom = workstationPrCommitMessageAtomFamily(evicted);
    for (let index = 0; index <= MAX_WARM_RELEASED_REPO_SCOPES; index += 1) {
      retainWorkstationRepoScope(scope(index))();
    }

    expect(workstationPrCommitMessageAtomFamily(evicted)).toBe(draftAtom);
  });
});
