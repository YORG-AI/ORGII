import type { PrBaseResolution } from "@src/api/tauri/github";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  isPrSource,
  mergeResolvedPrBase,
  prNumberFromSourceRef,
} from "../worktreeSourceResolve";

function prSource(
  overrides?: Partial<WorktreeLaunchSource>
): WorktreeLaunchSource {
  return {
    kind: "github",
    label: "#42 Add caching",
    baseBranch: "feature/add-caching",
    sourceRef: "pr:42",
    title: "Add caching",
    ...overrides,
  };
}

function resolution(overrides?: Partial<PrBaseResolution>): PrBaseResolution {
  return {
    baseRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    branchNameOverride: "feature/add-caching",
    compareBaseRef: "refs/remotes/origin/main",
    source: "branch",
    ...overrides,
  };
}

describe("isPrSource", () => {
  it("is true for a github PR source", () => {
    expect(isPrSource(prSource())).toBe(true);
  });

  it("is false for a github issue source", () => {
    expect(
      isPrSource(prSource({ sourceRef: "issue:7", label: "#7 Bug" }))
    ).toBe(false);
  });

  it("is false for non-github kinds", () => {
    expect(
      isPrSource({
        kind: "branch",
        label: "Branch: main",
        baseBranch: "main",
        sourceRef: "branch:main",
      })
    ).toBe(false);
  });

  it("is false for null", () => {
    expect(isPrSource(null)).toBe(false);
  });
});

describe("prNumberFromSourceRef", () => {
  it("parses a pr:<n> ref", () => {
    expect(prNumberFromSourceRef("pr:128")).toBe(128);
  });

  it("returns null for issue refs", () => {
    expect(prNumberFromSourceRef("issue:9")).toBeNull();
  });

  it("returns null for undefined / malformed refs", () => {
    expect(prNumberFromSourceRef(undefined)).toBeNull();
    expect(prNumberFromSourceRef("pr:abc")).toBeNull();
    expect(prNumberFromSourceRef("pr:0")).toBeNull();
  });
});

describe("mergeResolvedPrBase", () => {
  it("stores the head SHA as resolvedBaseRef (same-repo PR)", () => {
    const merged = mergeResolvedPrBase(prSource(), resolution());
    expect(merged.resolvedBaseRef).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    expect(merged.branchNameOverride).toBe("feature/add-caching");
    expect(merged.baseBranch).toBe("feature/add-caching");
    // The synthetic sourceRef and kind are preserved.
    expect(merged.sourceRef).toBe("pr:42");
    expect(merged.kind).toBe("github");
  });

  it("keeps the source baseBranch label when the resolver had no branch name (fork PR)", () => {
    const merged = mergeResolvedPrBase(
      prSource({ baseBranch: "#128 head" }),
      resolution({
        baseRef: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        branchNameOverride: null,
        source: "pullRef",
      })
    );
    expect(merged.resolvedBaseRef).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    expect(merged.branchNameOverride).toBeUndefined();
    expect(merged.baseBranch).toBe("#128 head");
  });

  it("trims a whitespace-only branch override to undefined", () => {
    const merged = mergeResolvedPrBase(
      prSource({ baseBranch: "orig" }),
      resolution({ branchNameOverride: "   " })
    );
    expect(merged.branchNameOverride).toBeUndefined();
    expect(merged.baseBranch).toBe("orig");
  });
});
