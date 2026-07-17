import type { WorktreeBranchOption } from "../worktreeBranchSource";
import {
  type SmartIssueInput,
  type SmartPrInput,
  type SmartSuggestionSources,
  buildSmartSuggestions,
  nameToLaunchSource,
  parseSmartInput,
  slugFragment,
} from "../worktreeSmartInput";

function branch(
  overrides?: Partial<WorktreeBranchOption>
): WorktreeBranchOption {
  return { name: "main", isRemote: false, isCurrent: false, ...overrides };
}

function pr(overrides?: Partial<SmartPrInput>): SmartPrInput {
  return {
    number: 42,
    title: "Add caching",
    headBranch: "feature/add-caching",
    baseBranch: "main",
    ...overrides,
  };
}

function issue(overrides?: Partial<SmartIssueInput>): SmartIssueInput {
  return { number: 7, title: "Bug report", ...overrides };
}

function sources(
  overrides?: Partial<SmartSuggestionSources>
): SmartSuggestionSources {
  return {
    prs: [],
    issues: [],
    branches: [],
    branchName: "develop",
    repoName: "acme/app",
    repoFullName: "acme/app",
    ...overrides,
  };
}

describe("parseSmartInput", () => {
  it("classifies empty / whitespace input", () => {
    expect(parseSmartInput("")).toEqual({ type: "empty" });
    expect(parseSmartInput("   ")).toEqual({ type: "empty" });
  });

  it("classifies #123 and bare digits as a PR number", () => {
    expect(parseSmartInput("#123")).toEqual({
      type: "prNumber",
      number: 123,
      hash: true,
    });
    expect(parseSmartInput("456")).toEqual({
      type: "prNumber",
      number: 456,
      hash: false,
    });
  });

  it("classifies owner/repo#123 as a cross-repo PR", () => {
    expect(parseSmartInput("octo/hello#12")).toEqual({
      type: "crossRepoPr",
      owner: "octo",
      repo: "hello",
      number: 12,
    });
  });

  it("classifies a GitHub PR URL", () => {
    expect(parseSmartInput("https://github.com/octo/hello/pull/99")).toEqual({
      type: "prUrl",
      provider: "github",
      host: "github.com",
      owner: "octo",
      repo: "hello",
      number: 99,
      resource: "pull",
    });
  });

  it("classifies a GitHub issue URL", () => {
    const parsed = parseSmartInput("https://github.com/octo/hello/issues/5");
    expect(parsed).toMatchObject({
      type: "prUrl",
      provider: "github",
      resource: "issue",
      number: 5,
    });
  });

  it("classifies a GitLab merge-request URL (subgroups collapse into owner)", () => {
    expect(
      parseSmartInput("https://gitlab.com/group/sub/app/-/merge_requests/45")
    ).toEqual({
      type: "prUrl",
      provider: "gitlab",
      host: "gitlab.com",
      owner: "group/sub",
      repo: "app",
      number: 45,
      resource: "merge_request",
    });
  });

  it("falls back to free text for anything else", () => {
    expect(parseSmartInput("feature/login")).toEqual({
      type: "text",
      value: "feature/login",
    });
    expect(parseSmartInput("my worktree")).toEqual({
      type: "text",
      value: "my worktree",
    });
  });
});

describe("slugFragment / nameToLaunchSource", () => {
  it("slugs free text and falls back to 'worktree'", () => {
    expect(slugFragment("My Feature!")).toBe("my-feature");
    expect(slugFragment("***")).toBe("worktree");
  });

  it("builds a name source with the current branch as base", () => {
    expect(nameToLaunchSource("Cool Thing", "  develop  ")).toEqual({
      kind: "name",
      label: "Name: Cool Thing",
      baseBranch: "develop",
      sourceRef: "name:cool-thing",
      title: "Cool Thing",
    });
  });

  it("returns null for empty input", () => {
    expect(nameToLaunchSource("   ")).toBeNull();
  });
});

describe("buildSmartSuggestions — empty query", () => {
  it("returns recent PRs and branches without synthetic smart default rows", () => {
    const result = buildSmartSuggestions(
      "",
      sources({
        prs: [pr({ number: 1 }), pr({ number: 2 })],
        branches: [branch({ name: "main" }), branch({ name: "dev" })],
      })
    );
    expect(result.every((s) => s.kind === "pr" || s.kind === "branch")).toBe(
      true
    );
    expect(result.some((s) => s.kind === "pr")).toBe(true);
    expect(result.some((s) => s.kind === "branch")).toBe(true);
    // PRs precede branches in the default (empty-query) ordering.
    expect(result[0].kind).toBe("pr");
  });

  it("respects the PR / branch limits", () => {
    const result = buildSmartSuggestions(
      "",
      sources({
        prs: Array.from({ length: 10 }, (_, i) => pr({ number: i + 1 })),
        branches: Array.from({ length: 10 }, (_, i) =>
          branch({ name: `b${i}` })
        ),
      }),
      { prs: 2, branches: 3, total: 40 }
    );
    expect(result.filter((s) => s.kind === "pr")).toHaveLength(2);
    expect(result.filter((s) => s.kind === "branch")).toHaveLength(3);
  });
});

describe("buildSmartSuggestions — PR number", () => {
  it("enriches a #<n> match from the fetched list and carries resolve meta", () => {
    const [first] = buildSmartSuggestions("#42", sources({ prs: [pr()] }));
    expect(first.kind).toBe("pr");
    expect(first.source.sourceRef).toBe("pr:42");
    expect(first.pr).toEqual({
      prNumber: 42,
      headBranch: "feature/add-caching",
      baseBranch: "main",
    });
  });

  it("still offers a resolvable PR row for an unlisted number", () => {
    const [first] = buildSmartSuggestions("#900", sources());
    expect(first.kind).toBe("pr");
    expect(first.pr).toEqual({ prNumber: 900 });
    expect(first.detail).toBe("Pull request");
  });

  it("surfaces a matching issue alongside the PR row", () => {
    const result = buildSmartSuggestions(
      "#7",
      sources({ issues: [issue({ number: 7 })] })
    );
    expect(result.map((s) => s.kind)).toContain("issue");
  });
});

describe("buildSmartSuggestions — cross-repo PR", () => {
  it("treats owner/repo#n matching origin as a resolvable PR", () => {
    const [first] = buildSmartSuggestions(
      "acme/app#12",
      sources({ repoFullName: "acme/app" })
    );
    expect(first.kind).toBe("pr");
    expect(first.pr).toEqual({ prNumber: 12 });
  });

  it("treats a foreign owner/repo#n as a non-resolvable named reference", () => {
    const [first] = buildSmartSuggestions(
      "other/repo#12",
      sources({ repoFullName: "acme/app" })
    );
    expect(first.kind).toBe("name");
    expect(first.source.kind).toBe("name");
    expect(first.source.baseBranch).toBe("develop");
    expect(first.detail).toContain("not resolvable");
  });
});

describe("buildSmartSuggestions — URLs", () => {
  it("resolves a GitHub PR URL that matches origin", () => {
    const [first] = buildSmartSuggestions(
      "https://github.com/acme/app/pull/99",
      sources({ repoFullName: "acme/app" })
    );
    expect(first.kind).toBe("pr");
    expect(first.pr).toEqual({ prNumber: 99 });
  });

  it("keeps a foreign GitHub PR URL as a named reference", () => {
    const [first] = buildSmartSuggestions(
      "https://github.com/other/repo/pull/99",
      sources({ repoFullName: "acme/app" })
    );
    expect(first.kind).toBe("name");
    expect(first.detail).toContain("not resolvable");
  });

  it("keeps a GitLab MR URL as a non-resolvable named reference", () => {
    const [first] = buildSmartSuggestions(
      "https://gitlab.com/group/app/-/merge_requests/45",
      sources({ repoFullName: "acme/app" })
    );
    expect(first.kind).toBe("name");
    expect(first.source.kind).toBe("name");
    expect(first.detail).toContain("not resolvable");
  });
});

describe("buildSmartSuggestions — free text", () => {
  it("floats an exact branch match to the top and always appends a name row", () => {
    const result = buildSmartSuggestions(
      "main",
      sources({
        branches: [branch({ name: "release" }), branch({ name: "main" })],
      })
    );
    expect(result[0].kind).toBe("branch");
    expect(result[0].title).toBe("main");
    expect(result[result.length - 1].kind).toBe("name");
  });

  it("offers a custom-ref row when the query matches no exact branch", () => {
    const result = buildSmartSuggestions(
      "v1.2.0",
      sources({ branches: [branch({ name: "main" })] })
    );
    expect(result.some((s) => s.kind === "customRef")).toBe(true);
    expect(result.some((s) => s.kind === "name")).toBe(true);
  });

  it("matches PRs by title substring", () => {
    const result = buildSmartSuggestions("caching", sources({ prs: [pr()] }));
    expect(result.some((s) => s.kind === "pr")).toBe(true);
  });

  it("does not offer a custom-ref row when the query exactly matches a branch", () => {
    const result = buildSmartSuggestions(
      "main",
      sources({ branches: [branch({ name: "main" })] })
    );
    expect(result.some((s) => s.kind === "customRef")).toBe(false);
  });

  it("degrades to name + custom ref when no PRs or branches are available", () => {
    const result = buildSmartSuggestions("anything", sources());
    expect(result.map((s) => s.kind)).toEqual(["customRef", "name"]);
  });
});
