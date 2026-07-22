import {
  type RawGitBranch,
  type WorktreeBranchOption,
  branchToLaunchSource,
  compactText,
  customRefToLaunchSource,
  filterBranchOptions,
  formatBranchTimestamp,
  groupBranchOptions,
  shouldOfferCustomRef,
  sortBranchOptions,
  sourceKey,
  toBranchOptions,
} from "../worktreeBranchSource";

function option(
  overrides?: Partial<WorktreeBranchOption>
): WorktreeBranchOption {
  return {
    name: "main",
    isRemote: false,
    isCurrent: false,
    ...overrides,
  };
}

describe("compactText", () => {
  it("collapses internal whitespace and trims", () => {
    expect(compactText("  feat   x  ")).toBe("feat x");
  });

  it("truncates to (limit - 1) chars plus an ellipsis beyond the limit", () => {
    expect(compactText("x".repeat(60), 10)).toBe(`${"x".repeat(9)}...`);
    expect(compactText("x".repeat(60), 10).endsWith("...")).toBe(true);
  });
});

describe("sourceKey", () => {
  it("includes every field that distinguishes a launch source", () => {
    expect(
      sourceKey({
        kind: "branch",
        label: "main",
        sourceRef: "branch:main",
        baseBranch: "main",
      })
    ).toBe("branch:branch:main:main:main");
  });
});

describe("toBranchOptions", () => {
  it("returns [] for undefined / null", () => {
    expect(toBranchOptions(undefined)).toEqual([]);
    expect(toBranchOptions(null)).toEqual([]);
  });

  it("maps local + remote rows and flags is_remote / is_current", () => {
    const raw: RawGitBranch[] = [
      {
        name: "main",
        branch_type: "local",
        is_current: true,
        last_commit_date: "2026-07-10T10:00:00Z",
      },
      { name: "origin/develop", branch_type: "remote", is_current: false },
    ];
    const options = toBranchOptions(raw);
    expect(options).toEqual([
      {
        name: "main",
        isRemote: false,
        isCurrent: true,
        lastCommitDate: "2026-07-10T10:00:00Z",
      },
      {
        name: "origin/develop",
        isRemote: true,
        isCurrent: false,
        lastCommitDate: undefined,
      },
    ]);
  });

  it("skips empty names, HEAD, and HEAD -> aliases", () => {
    const raw: RawGitBranch[] = [
      { name: "  ", branch_type: "local" },
      { name: "HEAD", branch_type: "local" },
      { name: "origin/HEAD -> origin/main", branch_type: "remote" },
      { name: "feature/x", branch_type: "local" },
    ];
    expect(toBranchOptions(raw).map((o) => o.name)).toEqual(["feature/x"]);
  });

  it("de-duplicates by name (keeps first)", () => {
    const raw: RawGitBranch[] = [
      { name: "main", branch_type: "local", is_current: true },
      { name: "main", branch_type: "local", is_current: false },
    ];
    const options = toBranchOptions(raw);
    expect(options).toHaveLength(1);
    expect(options[0].isCurrent).toBe(true);
  });
});

describe("sortBranchOptions", () => {
  it("orders current → local → remote, then by recency, then alpha", () => {
    const options: WorktreeBranchOption[] = [
      option({ name: "origin/develop", isRemote: true }),
      option({ name: "zeta", lastCommitDate: "2026-07-01T00:00:00Z" }),
      option({ name: "alpha", lastCommitDate: "2026-07-05T00:00:00Z" }),
      option({ name: "current", isCurrent: true }),
    ];
    expect(sortBranchOptions(options).map((o) => o.name)).toEqual([
      "current",
      "alpha",
      "zeta",
      "origin/develop",
    ]);
  });

  it("does not mutate the input array", () => {
    const options = [option({ name: "b" }), option({ name: "a" })];
    const snapshot = options.map((o) => o.name);
    sortBranchOptions(options);
    expect(options.map((o) => o.name)).toEqual(snapshot);
  });
});

describe("filterBranchOptions", () => {
  const options: WorktreeBranchOption[] = [
    option({ name: "main" }),
    option({ name: "origin/develop", isRemote: true }),
    option({ name: "junyu/fix-chat" }),
  ];

  it("returns all options for an empty / whitespace query", () => {
    expect(filterBranchOptions(options, "")).toHaveLength(3);
    expect(filterBranchOptions(options, "   ")).toHaveLength(3);
  });

  it("matches case-insensitively on any part of the name", () => {
    expect(filterBranchOptions(options, "DEV").map((o) => o.name)).toEqual([
      "origin/develop",
    ]);
    expect(filterBranchOptions(options, "junyu").map((o) => o.name)).toEqual([
      "junyu/fix-chat",
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterBranchOptions(options, "nope")).toEqual([]);
  });
});

describe("shouldOfferCustomRef", () => {
  const options: WorktreeBranchOption[] = [
    option({ name: "main" }),
    option({ name: "origin/develop", isRemote: true }),
  ];

  it("is false for an empty query", () => {
    expect(shouldOfferCustomRef("", options)).toBe(false);
    expect(shouldOfferCustomRef("   ", options)).toBe(false);
  });

  it("is false when the query exactly matches a branch name", () => {
    expect(shouldOfferCustomRef("main", options)).toBe(false);
    expect(shouldOfferCustomRef("origin/develop", options)).toBe(false);
  });

  it("is true for a non-matching ref (tag / sha / partial)", () => {
    expect(shouldOfferCustomRef("v1.2.0", options)).toBe(true);
    expect(shouldOfferCustomRef("mai", options)).toBe(true);
    expect(shouldOfferCustomRef("deadbeef", options)).toBe(true);
  });
});

describe("branchToLaunchSource", () => {
  it("builds a resolvable branch source for a local branch", () => {
    expect(branchToLaunchSource(option({ name: "main" }))).toEqual({
      kind: "branch",
      label: "Branch: main",
      baseBranch: "main",
      sourceRef: "branch:main",
      title: "main",
    });
  });

  it("uses the remote short-ref form (origin/develop) as the base", () => {
    const source = branchToLaunchSource(
      option({ name: "origin/develop", isRemote: true })
    );
    expect(source.baseBranch).toBe("origin/develop");
    expect(source.sourceRef).toBe("branch:origin/develop");
  });

  it("preserves an existing worktree path as an explicit reuse source", () => {
    expect(
      branchToLaunchSource(
        option({ name: "feature/reuse", worktreePath: "/worktrees/reuse" })
      )
    ).toEqual({
      kind: "worktree",
      label: "Worktree: feature/reuse",
      baseBranch: "feature/reuse",
      sourceRef: "worktree:/worktrees/reuse",
      title: "feature/reuse",
      existingWorktreePath: "/worktrees/reuse",
    });
  });
});

describe("groupBranchOptions", () => {
  // Descending commit dates so ordering into Recent is deterministic.
  function dated(name: string, day: number): WorktreeBranchOption {
    return option({
      name,
      lastCommitDate: `2026-07-${String(day).padStart(2, "0")}T00:00:00Z`,
    });
  }

  it("returns [] for an empty option list", () => {
    expect(groupBranchOptions([])).toEqual([]);
  });

  it("puts a small list into a single Recent group", () => {
    const groups = groupBranchOptions([
      dated("a", 10),
      dated("b", 9),
      dated("c", 8),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("recent");
    expect(groups[0].labelKey).toBe("recent");
    expect(groups[0].options.map((o) => o.name)).toEqual(["a", "b", "c"]);
  });

  it("buckets a worktree-mapped branch into the Worktrees group", () => {
    const options = [
      dated("f1", 12),
      dated("f2", 11),
      dated("f3", 10),
      dated("f4", 9),
      dated("f5", 8),
      dated("wt", 1), // oldest → falls out of Recent (top 5)
    ];
    const groups = groupBranchOptions(
      options,
      new Map([["wt", "/repo/.worktrees/wt"]])
    );
    const worktrees = groups.find((g) => g.key === "worktrees");
    expect(worktrees).toBeDefined();
    expect(worktrees?.labelKey).toBe("worktrees");
    expect(worktrees?.options.map((o) => o.name)).toEqual(["wt"]);
    expect(worktrees?.options[0].worktreePath).toBe("/repo/.worktrees/wt");
    // Recent keeps the 5 most-recent, none carrying the worktree path.
    const recent = groups.find((g) => g.key === "recent");
    expect(recent?.options.map((o) => o.name)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
    ]);
  });

  it("flattens default + other branches into a single Other group tail", () => {
    const options = [
      dated("f1", 12),
      dated("f2", 11),
      dated("f3", 10),
      dated("f4", 9),
      dated("f5", 8),
      dated("main", 1), // oldest default branch → Other tail
    ];
    const groups = groupBranchOptions(options);
    const other = groups.find((g) => g.key === "other");
    expect(other).toBeDefined();
    expect(other?.labelKey).toBe("otherBranches");
    expect(other?.options.map((o) => o.name)).toContain("main");
  });

  it("ignores worktree paths for names not present in the option list", () => {
    const groups = groupBranchOptions(
      [dated("a", 10)],
      new Map([["ghost", "/nowhere"]])
    );
    expect(groups.some((g) => g.key === "worktrees")).toBe(false);
    expect(groups[0].options[0].worktreePath).toBeUndefined();
  });
});

describe("formatBranchTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns '' when the branch has no commit date", () => {
    expect(formatBranchTimestamp(option({ lastCommitDate: undefined }))).toBe(
      ""
    );
  });

  it("formats a recent commit with the shared 'short' relative style", () => {
    expect(
      formatBranchTimestamp(option({ lastCommitDate: "2026-07-11T11:00:00Z" }))
    ).toBe("1 hr ago");
    expect(
      formatBranchTimestamp(option({ lastCommitDate: "2026-07-10T12:00:00Z" }))
    ).toBe("Yesterday");
    expect(
      formatBranchTimestamp(option({ lastCommitDate: "2026-07-09T12:00:00Z" }))
    ).toBe("2 days ago");
  });
});

describe("customRefToLaunchSource", () => {
  it("returns null for empty / whitespace input", () => {
    expect(customRefToLaunchSource("")).toBeNull();
    expect(customRefToLaunchSource("   ")).toBeNull();
  });

  it("trims and builds a branch source for an arbitrary ref", () => {
    expect(customRefToLaunchSource("  v1.0.0 ")).toEqual({
      kind: "branch",
      label: "Branch: v1.0.0",
      baseBranch: "v1.0.0",
      sourceRef: "branch:v1.0.0",
      title: "v1.0.0",
    });
  });

  it("truncates the label but keeps the full ref as base", () => {
    const long = "feature/".concat("x".repeat(60));
    const source = customRefToLaunchSource(long);
    expect(source?.baseBranch).toBe(long);
    // Label truncates the ref to (36 - 1) chars + "..." after the prefix.
    expect(source?.label.startsWith("Branch: ")).toBe(true);
    expect(source?.label.endsWith("...")).toBe(true);
    expect(source?.label.length ?? 0).toBeLessThanOrEqual(
      "Branch: ".length + 36 + 2
    );
  });
});
