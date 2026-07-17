import {
  inlineExternalImportRowKey,
  resolveHasImportable,
} from "../inlineExternalImportUtils";

describe("inlineExternalImportRowKey", () => {
  it("combines all four fields with colon separators", () => {
    const key = inlineExternalImportRowKey({
      sourceAgent: "claude_code",
      sourcePath: "/home/user/.claude/CLAUDE.md",
      suggestedName: "global-rules",
      targetRepoPath: "/home/user/projects/foo",
    });
    expect(key).toBe(
      "claude_code:/home/user/.claude/CLAUDE.md:global-rules:/home/user/projects/foo"
    );
  });

  it("uses the literal string 'global' for null targetRepoPath", () => {
    const key = inlineExternalImportRowKey({
      sourceAgent: "cursor_ide",
      sourcePath: "/Users/me/.cursor/rules/my-rule.mdc",
      suggestedName: "my-rule",
      targetRepoPath: null,
    });
    expect(key).toContain(":global");
    expect(key).toBe(
      "cursor_ide:/Users/me/.cursor/rules/my-rule.mdc:my-rule:global"
    );
  });

  it("produces distinct keys for the same artifact in different scopes", () => {
    const base = {
      sourceAgent: "copilot" as const,
      sourcePath: "/home/user/.github/copilot/instructions.md",
      suggestedName: "instructions",
    };
    const globalKey = inlineExternalImportRowKey({
      ...base,
      targetRepoPath: null,
    });
    const repoKey = inlineExternalImportRowKey({
      ...base,
      targetRepoPath: "/home/user/myrepo",
    });
    expect(globalKey).not.toBe(repoKey);
  });

  it("produces distinct keys for the same sourcePath with different suggestedNames", () => {
    const base = {
      sourceAgent: "kiro" as const,
      sourcePath: "/home/user/.kiro/steering/docs.md",
      targetRepoPath: null,
    };
    const key1 = inlineExternalImportRowKey({ ...base, suggestedName: "docs" });
    const key2 = inlineExternalImportRowKey({
      ...base,
      suggestedName: "docs-copy",
    });
    expect(key1).not.toBe(key2);
  });

  it("is stable — same input always returns same string", () => {
    const row = {
      sourceAgent: "codex" as const,
      sourcePath: "/home/user/.codex/AGENTS.md",
      suggestedName: "codex-context",
      targetRepoPath: "/repos/project",
    };
    expect(inlineExternalImportRowKey(row)).toBe(
      inlineExternalImportRowKey(row)
    );
  });
});

describe("resolveHasImportable", () => {
  const nonEmpty = [1, 2, 3];
  const empty: unknown[] = [];

  describe('strategy "all"', () => {
    it("returns true when allImportableItems is non-empty", () => {
      expect(resolveHasImportable("all", nonEmpty, empty)).toBe(true);
    });

    it("returns false when allImportableItems is empty", () => {
      expect(resolveHasImportable("all", empty, nonEmpty)).toBe(false);
    });

    it("returns false when both are empty", () => {
      expect(resolveHasImportable("all", empty, empty)).toBe(false);
    });
  });

  describe('strategy "filtered"', () => {
    it("returns true when importableItems is non-empty", () => {
      expect(resolveHasImportable("filtered", empty, nonEmpty)).toBe(true);
    });

    it("returns false when importableItems is empty", () => {
      expect(resolveHasImportable("filtered", nonEmpty, empty)).toBe(false);
    });

    it("returns false when both are empty", () => {
      expect(resolveHasImportable("filtered", empty, empty)).toBe(false);
    });
  });
});
