import { describe, expect, it } from "vitest";

import {
  conversationExecutions,
  conversationRootForSession,
  conversationSourceFromImportedHistory,
  latestConversationExecution,
  mergeConversationExecutionTargets,
  resolveConversationExecutionTargetHydration,
  resolveNativeConversationCliTargets,
  writableConversationWorkspacePath,
} from "./useConversationTargetBinding";

describe("conversation target binding source", () => {
  it("keeps an installed shell-out Claude runtime without GUI launch support", () => {
    expect(
      resolveNativeConversationCliTargets(
        [
          { name: "claude_code", installed: true, supportsGui: false },
          { name: "codex", installed: true, supportsGui: true },
        ] as never,
        true
      )
    ).toEqual(["claude_code", "codex"]);
  });

  it("projects a native imported history onto the canonical runtime picker", () => {
    expect(
      conversationSourceFromImportedHistory({
        sessionId: "claudecodeapp-session-1",
        session: {
          name: "Native Claude history",
          model: "claude-opus-5",
          repoPath: "/repo",
        } as never,
      })
    ).toMatchObject({
      cliAgentType: "claude_code",
      model: "claude-opus-5",
      workspaceRepoPath: "/repo",
      initialTarget: null,
    });
  });

  it("keeps an execution child's encoded Cloud root authoritative", () => {
    const root = {
      authority: "org2-cloud",
      authorityScope: ["org-1"],
      conversationId: "root-1",
    } as const;
    const parentSessionId = JSON.stringify([
      "org2-conversation",
      1,
      root.authority,
      root.authorityScope,
      root.conversationId,
    ]);

    expect(
      conversationRootForSession({
        session_id: "native-child",
        parentSessionId,
        cliAgentType: "codex",
      } as never)
    ).toEqual(root);
  });

  it("prefers the discovered local git root over a stale source worktree", () => {
    expect(
      conversationSourceFromImportedHistory({
        sessionId: "claudecodeapp-session-1",
        session: {
          name: "Native Claude history",
          repoPath: "/deleted/source-worktree",
          repoRootPath: "/local/repo-root",
        } as never,
      })
    ).toMatchObject({
      workspaceRepoPath: "/local/repo-root",
    });
  });

  it("keeps every imported provider eligible without native source resume", () => {
    expect(
      conversationSourceFromImportedHistory({
        sessionId: "windsurfapp-session-1",
      })
    ).toMatchObject({
      cliAgentType: undefined,
      workspaceRepoPath: null,
      initialTarget: null,
    });
  });

  it("keeps the writable episode checkout on later turns", () => {
    expect(
      writableConversationWorkspacePath(
        {
          repoPath: "/local/writable-episode",
        } as never,
        {
          repoPath: "/deleted/imported-worktree",
          repoRootPath: "/local/root-fallback",
        } as never
      )
    ).toBe("/local/writable-episode");
  });

  it("derives the remembered runtime from the newest persisted episode", () => {
    const root = {
      authority: "org2-cloud",
      authorityScope: ["org-1"],
      conversationId: "root-1",
    };
    const parentSessionId = JSON.stringify([
      "org2-conversation",
      1,
      root.authority,
      root.authorityScope,
      root.conversationId,
    ]);
    expect(
      latestConversationExecution(
        [
          {
            session_id: "older-codex",
            parentSessionId,
            updated_at: "2026-08-29T10:00:00Z",
          },
          {
            session_id: "newer-claude",
            parentSessionId,
            updated_at: "2026-08-29T11:00:00Z",
          },
          {
            session_id: "other-root",
            parentSessionId: "other",
            updated_at: "2026-08-29T12:00:00Z",
          },
        ] as never,
        root
      )?.session_id
    ).toBe("newer-claude");

    expect(
      conversationExecutions(
        [
          {
            session_id: "older-codex",
            parentSessionId,
            updated_at: "2026-08-29T10:00:00Z",
          },
          {
            session_id: "newer-claude",
            parentSessionId,
            updated_at: "2026-08-29T11:00:00Z",
          },
        ] as never,
        root
      ).map((session) => session.session_id)
    ).toEqual(["newer-claude", "older-codex"]);
  });

  it("uses durable hidden executions as the restart authority", () => {
    const durable = [
      {
        sessionId: "hidden-codex",
        updatedAt: "2026-09-05T12:00:00.000Z",
        target: {
          cliAgentType: "codex",
          accountId: "openai-1",
          model: "gpt-5.6-sol",
          workspaceRepoPath: "/repo",
        },
      },
    ] as const;

    expect(
      resolveConversationExecutionTargetHydration(
        "root-a",
        { rootKey: "root-a", status: "ready", targets: durable },
        []
      )
    ).toEqual({ loading: false, failed: false, targets: durable });
  });

  it("stays loading instead of falling back while a new root hydrates", () => {
    const staleTarget = {
      sessionId: "old-claude",
      updatedAt: "2026-09-05T12:00:00.000Z",
      target: {
        cliAgentType: "claude_code",
        accountId: "anthropic-1",
        model: "sonnet",
        workspaceRepoPath: "/repo",
      },
    } as const;

    expect(
      resolveConversationExecutionTargetHydration(
        "new-root",
        { rootKey: "old-root", status: "ready", targets: [staleTarget] },
        []
      )
    ).toEqual({ loading: true, failed: false, targets: [] });
  });

  it("uses a live execution immediately while durable history hydrates", () => {
    const liveTarget = {
      sessionId: "live-codex",
      updatedAt: "2026-09-05T12:00:00.000Z",
      target: {
        cliAgentType: "codex",
        accountId: "openai-1",
        model: "gpt-5.6-sol",
      },
    } as const;

    expect(
      resolveConversationExecutionTargetHydration("root-a", null, [liveTarget])
    ).toEqual({ loading: false, failed: false, targets: [liveTarget] });
  });

  it("retains historical runtime pairs while applying a newer live overlay", () => {
    const durable = [
      {
        sessionId: "codex",
        updatedAt: "2026-09-05T10:00:00.000Z",
        target: {
          cliAgentType: "codex",
          accountId: "openai-1",
          model: "gpt-5.6-sol",
        },
      },
      {
        sessionId: "claude",
        updatedAt: "2026-09-05T09:00:00.000Z",
        target: {
          cliAgentType: "claude_code",
          accountId: "anthropic-1",
          model: "sonnet",
        },
      },
    ] as const;
    const live = [
      {
        sessionId: "claude",
        updatedAt: "2026-09-05T11:00:00.000Z",
        target: {
          cliAgentType: "claude_code",
          accountId: "anthropic-1",
          model: "opus",
        },
      },
    ] as const;

    expect(
      mergeConversationExecutionTargets(durable, live).map(
        ({ sessionId, target }) => [sessionId, target.model]
      )
    ).toEqual([
      ["claude", "opus"],
      ["codex", "gpt-5.6-sol"],
    ]);
  });
});
