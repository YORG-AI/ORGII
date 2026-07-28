import { describe, expect, it } from "vitest";

import { SessionLaunchInput } from "../agentSession";

const baseInput = {
  params: {
    category: "rust_agent" as const,
    content: "inspect the repository",
    workspacePath: "/repo",
  },
};

describe("SessionLaunchInput workspace contract", () => {
  it("accepts local, fresh-isolated, and existing-worktree modes", () => {
    expect(SessionLaunchInput.safeParse(baseInput).success).toBe(true);
    expect(
      SessionLaunchInput.safeParse({
        params: {
          ...baseInput.params,
          isolate: true,
          worktreeBaseRef: "develop",
        },
      }).success
    ).toBe(true);
    expect(
      SessionLaunchInput.safeParse({
        params: {
          ...baseInput.params,
          worktreePath: "/repo-linked",
        },
      }).success
    ).toBe(true);
  });

  it("rejects mutually exclusive fresh and existing worktree fields", () => {
    const result = SessionLaunchInput.safeParse({
      params: {
        ...baseInput.params,
        isolate: true,
        worktreePath: "/repo-linked",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a worktree base ref without fresh isolation", () => {
    const result = SessionLaunchInput.safeParse({
      params: {
        ...baseInput.params,
        worktreeBaseRef: "develop",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects worktree mode without a workspace root", () => {
    const result = SessionLaunchInput.safeParse({
      params: {
        category: "cli_agent",
        content: "inspect",
        isolate: true,
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown launch fields", () => {
    const result = SessionLaunchInput.safeParse({
      params: {
        ...baseInput.params,
        worktreeBasRef: "typo",
      },
    });
    expect(result.success).toBe(false);
  });
});
