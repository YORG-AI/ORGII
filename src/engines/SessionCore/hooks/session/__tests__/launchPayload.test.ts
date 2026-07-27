import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import { SESSION_TARGET_KIND } from "@src/store/session";

import {
  buildSessionFromLaunchResult,
  buildSessionLaunchPayload,
} from "../useSessionCreator/useSessionLaunch/launchPayload";

describe("launchPayload", () => {
  it("persists launch workspacePath on the frontend session row", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: {
        type: "local",
        repoId: "repo-1",
        repoName: "Repo One",
        repoPath: "/workspace/repo-one",
      },
      isBackgroundLaunch: false,
      result: {
        sessionId: "agent-1",
        category: DISPATCH_CATEGORY.RUST_AGENT,
        name: "Test session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        workspacePath: "/workspace/repo-one",
        background: false,
      },
    });

    expect(session.repoPath).toBe("/workspace/repo-one");
  });

  it("persists CLI agent type on the optimistic session row", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: null,
      isBackgroundLaunch: false,
      result: {
        sessionId: "cliagent-opencode",
        category: DISPATCH_CATEGORY.CLI_AGENT,
        name: "OpenCode session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        background: false,
        model: "minimax-m3",
        cliAgentType: "opencode",
      },
    });

    expect(session.cliAgentType).toBe("opencode");
  });

  it("falls back to the launch platform for the optimistic CLI session row", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: null,
      isBackgroundLaunch: false,
      launchCliAgentType: "opencode",
      result: {
        sessionId: "cliagent-opencode",
        category: DISPATCH_CATEGORY.CLI_AGENT,
        name: "OpenCode session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        background: false,
        model: "minimax-m3",
      },
    });

    expect(session.cliAgentType).toBe("opencode");
  });

  it("hydrates optimistic session org context from launch readback", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: null,
      isBackgroundLaunch: false,
      launchOrgContext: {
        orgId: "org-fallback",
        projectId: "project-fallback",
        projectName: "Fallback Project",
        projectSlug: "fallback-project",
        workItemId: "FB-1",
        agentRole: "custom",
      },
      result: {
        sessionId: "agent-1",
        category: DISPATCH_CATEGORY.RUST_AGENT,
        name: "Test session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        background: false,
        orgId: "org-platform",
        projectId: "project-runtime",
        projectName: "Runtime",
        projectSlug: "runtime",
        workItemId: "RUN-12",
        agentRole: "reviewer",
      },
    });

    expect(session.orgId).toBe("org-platform");
    expect(session.projectId).toBe("project-runtime");
    expect(session.projectName).toBe("Runtime");
    expect(session.projectSlug).toBe("runtime");
    expect(session.workItemId).toBe("RUN-12");
    expect(session.agentRole).toBe("reviewer");
  });

  it("hydrates optimistic session org context from launch fallback before readback", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: null,
      isBackgroundLaunch: false,
      launchOrgContext: {
        orgId: "org-platform",
        projectId: "project-runtime",
        projectName: "Runtime",
        projectSlug: "runtime",
        workItemId: "RUN-12",
        agentRole: "custom",
      },
      result: {
        sessionId: "agent-1",
        category: DISPATCH_CATEGORY.RUST_AGENT,
        name: "Test session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        background: false,
      },
    });

    expect(session.orgId).toBe("org-platform");
    expect(session.projectId).toBe("project-runtime");
    expect(session.projectName).toBe("Runtime");
    expect(session.projectSlug).toBe("runtime");
    expect(session.workItemId).toBe("RUN-12");
    expect(session.agentRole).toBe("custom");
  });

  it("passes selected CLI agent type as the launch platform", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      dispatchCategory: DISPATCH_CATEGORY.CLI_AGENT,
      resolvedKeys: {
        ...baseLaunchOptions().resolvedKeys,
        cliAgentType: "opencode",
      },
    });

    expect(launchParams.platform).toBe("opencode");
  });

  it("passes non-primary multi-root folders as additional directories", () => {
    const { launchParams } = buildSessionLaunchPayload({
      agentExecMode: "build",
      agentInput: "hello",
      advancedConfig: {},
      dispatchCategory: DISPATCH_CATEGORY.RUST_AGENT,
      effectiveSource: {
        type: "local",
        repoId: "repo-a",
        repoName: "Repo A",
        repoPath: "/workspace/repo-a",
      },
      adeContext: undefined,
      imageDataUrls: undefined,
      isBackgroundLaunch: false,
      resolvedKeys: {
        accountId: "account-1",
        keySource: "own_key",
        model: "model-1",
        cliAgentType: undefined,
        nativeHarnessType: undefined,
        branch: undefined,
      },
      runningLocation: "local",
      selectedAgentDefId: "builtin:sde",
      selectedAgentOrgId: null,
      sessionName: "Test session",
      targetKind: SESSION_TARGET_KIND.AGENT,
      workspaceFolders: [
        { path: "/workspace/repo-a" },
        { path: "/workspace/repo-b" },
      ],
      worktreeLaunchSelection: null,
    });

    expect(launchParams.workspacePath).toBe("/workspace/repo-a");
    expect(launchParams.additionalDirectories).toEqual(["/workspace/repo-b"]);
  });

  it("loose-matches repoPath against workspace folders (trailing slash + case)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { launchParams } = buildSessionLaunchPayload({
        ...baseLaunchOptions(),
        effectiveSource: {
          type: "local",
          repoId: "repo-a",
          repoName: "Repo A",
          repoPath: "/Workspace/Repo-A/",
        },
        workspaceFolders: [
          { path: "/workspace/repo-a" },
          { path: "/workspace/repo-b" },
        ],
      });

      expect(launchParams.additionalDirectories).toEqual(["/workspace/repo-b"]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("loose-matched"),
        expect.objectContaining({ sessionRepoPath: "/Workspace/Repo-A/" })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("drops additional directories with a warning when repoPath matches no folder", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { launchParams } = buildSessionLaunchPayload({
        ...baseLaunchOptions(),
        effectiveSource: {
          type: "local",
          repoId: "repo-x",
          repoName: "Repo X",
          repoPath: "/elsewhere/repo-x",
        },
        workspaceFolders: [
          { path: "/workspace/repo-a" },
          { path: "/workspace/repo-b" },
        ],
      });

      expect(launchParams.additionalDirectories).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("dropping additional directories"),
        expect.objectContaining({
          sessionRepoPath: "/elsewhere/repo-x",
          droppedDirectories: ["/workspace/repo-a", "/workspace/repo-b"],
        })
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("omits worktree fields for a non-worktree (local) launch", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "local",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "branch",
          label: "Branch: feature/x",
          baseBranch: "feature/x",
          sourceRef: "branch:feature/x",
        },
      },
    });

    expect(launchParams.isolate).toBeUndefined();
    expect(launchParams.worktreePath).toBeUndefined();
  });

  it("isolates from HEAD when no worktree source base branch is present", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: null,
    });

    expect(launchParams.isolate).toBe(true);
    expect(launchParams.worktreePath).toBeUndefined();
    // No base branch on the source and none resolved → branch stays unset so
    // the backend isolates from current HEAD.
    expect(launchParams.branch).toBeUndefined();
  });

  it("forwards the worktree source base branch as the isolate base ref", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "github",
          label: "#42 Add caching",
          baseBranch: "feature/add-caching",
          sourceRef: "pr:42",
          title: "Add caching",
        },
      },
    });

    expect(launchParams.isolate).toBe(true);
    expect(launchParams.worktreeBaseRef).toBe("feature/add-caching");
    expect(launchParams.worktreePath).toBeUndefined();
  });

  it("prefers the resolved base ref (PR head SHA) over the base branch label", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "github",
          label: "#128 Fork feature",
          baseBranch: "contributor:feature",
          sourceRef: "pr:128",
          title: "Fork feature",
          resolvedBaseRef: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          branchNameOverride: "feature",
        },
      },
    });

    expect(launchParams.isolate).toBe(true);
    // Fork PR head branch is not a local ref — launch must use the fetched SHA.
    expect(launchParams.worktreeBaseRef).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
  });

  it("falls back to the base branch when no resolved base ref is present", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "github",
          label: "#42 Same repo",
          baseBranch: "feature/same-repo",
          sourceRef: "pr:42",
        },
      },
    });

    expect(launchParams.isolate).toBe(true);
    expect(launchParams.worktreeBaseRef).toBe("feature/same-repo");
  });

  it("trims whitespace from the resolved base ref", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "github",
          label: "#9 PR",
          baseBranch: "feature/x",
          sourceRef: "pr:9",
          resolvedBaseRef: "  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ",
        },
      },
    });

    expect(launchParams.worktreeBaseRef).toBe(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
  });

  it("ignores a blank resolved base ref and falls back to base branch", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "github",
          label: "#9 PR",
          baseBranch: "feature/x",
          sourceRef: "pr:9",
          resolvedBaseRef: "   ",
        },
      },
    });

    expect(launchParams.worktreeBaseRef).toBe("feature/x");
  });

  it("trims whitespace from the worktree source base branch", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "branch",
          label: "Branch: main",
          baseBranch: "  main  ",
          sourceRef: "branch:main",
        },
      },
    });

    expect(launchParams.isolate).toBe(true);
    expect(launchParams.worktreeBaseRef).toBe("main");
  });

  it("ignores a blank worktree source base branch and isolates from HEAD", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      resolvedKeys: {
        ...baseLaunchOptions().resolvedKeys,
        branch: "develop",
      },
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "name",
          label: "Name: quick-fix",
          baseBranch: "   ",
          sourceRef: "name:quick-fix",
        },
      },
    });

    expect(launchParams.isolate).toBe(true);
    expect(launchParams.worktreeBaseRef).toBeUndefined();
    // The normal session branch remains independent of the worktree base ref.
    expect(launchParams.branch).toBe("develop");
  });

  it("reuses an existing worktree path and ignores source base branch", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:repo-1",
        source: {
          kind: "worktree",
          label: "Worktree: feature/fix-bug",
          baseBranch: "feature/fix-bug",
          sourceRef: "worktree:/worktrees/existing",
          existingWorktreePath: "/worktrees/existing",
        },
      },
    });

    expect(launchParams.worktreePath).toBe("/worktrees/existing");
    expect(launchParams.isolate).toBeUndefined();
    // The existing worktree already carries its base ref; the source's base
    // branch must not leak into the payload here.
    expect(launchParams.worktreeBaseRef).toBeUndefined();
  });

  it("drops a stale worktree selection after the repository changes", () => {
    const { launchParams } = buildSessionLaunchPayload({
      ...baseLaunchOptions(),
      runningLocation: "worktree",
      worktreeLaunchSelection: {
        repoKey: "id:old-repo",
        source: {
          kind: "worktree",
          label: "Worktree: stale",
          existingWorktreePath: "/worktrees/stale",
        },
      },
    });

    expect(launchParams.worktreePath).toBeUndefined();
    expect(launchParams.worktreeBaseRef).toBeUndefined();
    expect(launchParams.isolate).toBe(true);
  });

  it("uses the authoritative worktree branch returned by the backend", () => {
    const session = buildSessionFromLaunchResult({
      agentExecMode: "build",
      effectiveSource: {
        type: "local",
        repoId: "repo-1",
        repoName: "Repo One",
        repoPath: "/workspace/repo-one",
        branch: "develop",
      },
      isBackgroundLaunch: false,
      result: {
        sessionId: "agent-1",
        category: DISPATCH_CATEGORY.RUST_AGENT,
        name: "Test session",
        status: "running",
        createdAt: "2026-01-01T00:00:00.000Z",
        userInput: "hello",
        workspacePath: "/workspace/repo-one",
        worktreePath: "/worktrees/agent-1",
        worktreeBranch: "agent/agent-1",
        branch: "develop",
        background: false,
      },
    });

    expect(session.branch).toBe("agent/agent-1");
    expect(session.worktreeBranch).toBe("agent/agent-1");
  });

  it("does not block launched-session navigation on workspace-open side effects", () => {
    const launchHookPath = fileURLToPath(
      new URL(
        "../useSessionCreator/useSessionLaunch/index.tsx",
        import.meta.url
      )
    );
    const source = readFileSync(launchHookPath, "utf8");

    expect(source).toContain("void emitOpenWorkspace(");
    expect(source).not.toContain("await emitOpenWorkspace(");
  });
});

function baseLaunchOptions(): Parameters<typeof buildSessionLaunchPayload>[0] {
  return {
    agentExecMode: "build",
    agentInput: "hello",
    advancedConfig: {},
    dispatchCategory: DISPATCH_CATEGORY.RUST_AGENT,
    effectiveSource: {
      type: "local",
      repoId: "repo-1",
      repoName: "Repo One",
      repoPath: "/workspace/repo-one",
    },
    adeContext: undefined,
    imageDataUrls: undefined,
    isBackgroundLaunch: false,
    resolvedKeys: {
      accountId: "account-1",
      keySource: "own_key",
      model: "model-1",
      cliAgentType: undefined,
      nativeHarnessType: undefined,
      branch: undefined,
    },
    runningLocation: "local",
    selectedAgentDefId: "builtin:sde",
    selectedAgentOrgId: null,
    sessionName: "Test session",
    targetKind: SESSION_TARGET_KIND.AGENT,
    workspaceFolders: [],
    worktreeLaunchSelection: null,
  };
}
