import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ImportedHistorySource,
  getImportedHistorySourceBySessionId,
} from "@src/api/tauri/externalHistory";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";
import type { ActivityChunk } from "@src/types/session/session";

import {
  buildExternalHistoryHandoffPrompt,
  forkExternalHistoryIntoOrgiiSession,
} from "./externalHistoryFork";

vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId: vi.fn(),
}));
vi.mock("@src/engines/SessionCore/services/SessionService", () => ({
  SessionService: { create: vi.fn() },
}));
vi.mock("@src/features/TeamCollaboration/forkSession", () => ({
  requestForkSessionSetup: vi.fn(),
}));
vi.mock("@src/features/TeamCollaboration/repoScopeResolver", () => ({
  resolveShareableScopeKeys: vi.fn(),
}));

function chunk(
  id: string,
  actionType: string,
  functionName: string,
  result: Record<string, unknown>
): ActivityChunk {
  return {
    chunk_id: id,
    action_type: actionType,
    function: functionName,
    args: {},
    result,
    created_at: "2026-07-13T00:00:00.000Z",
  };
}

describe("buildExternalHistoryHandoffPrompt", () => {
  it("works for every registered source label and excludes private reasoning", () => {
    const prompt = buildExternalHistoryHandoffPrompt(
      [
        chunk("u1", "raw", "user_message", { message: "fix the sync" }),
        chunk("r1", "reasoning", "thinking", {
          content: "private chain of thought",
        }),
        {
          ...chunk("t1", "tool_call", "read_file", { output: "old file" }),
          args: { path: "src/sync.ts" },
        },
        chunk("a1", "assistant_message", "assistant_message", {
          content: "I found the issue",
        }),
      ],
      "continue and verify it",
      "Claude App"
    );

    expect(prompt).toContain("imported Claude App history");
    expect(prompt).toContain("User: fix the sync");
    expect(prompt).toContain("[Imported Claude App action]");
    expect(prompt).toContain("Tool: read_file");
    expect(prompt).toContain("Assistant: I found the issue");
    expect(prompt).toContain("continue and verify it");
    expect(prompt).not.toContain("private chain of thought");
  });
});

describe("forkExternalHistoryIntoOrgiiSession", () => {
  const loadFullTranscriptChunks = vi.fn();
  const source: ImportedHistorySource = {
    sourceId: "codex_app",
    listCategory: "external_history:codex_app",
    prefix: "codexapp-",
    iconId: "codex",
    displayName: "Codex App",
    groupLabel: "Codex App",
    listable: true,
    replayable: true,
    supportsWindowedReplay: false,
    dispatchCategory: "external_history",
    loadPreviewChunks: vi.fn(),
    loadFullTranscriptChunks,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImportedHistorySourceBySessionId).mockReturnValue(source);
    vi.mocked(resolveShareableScopeKeys).mockResolvedValue([
      "github.com/org/repo",
    ]);
    vi.mocked(requestForkSessionSetup).mockResolvedValue({
      workspaceRepoPath: "/local/repo",
      execution: {
        agentDefinitionId: "custom:security-auditor",
        accountId: "openai",
        model: "gpt-test",
      },
    });
    loadFullTranscriptChunks.mockResolvedValue([
      chunk("u1", "user_message", "user_message", { message: "old ask" }),
    ]);
    vi.mocked(SessionService.create).mockResolvedValue({
      sessionId: "agentsession-forked",
    });
  });

  it("uses the shared setup before loading history, then creates one writable ORGII continuation", async () => {
    const callOrder: string[] = [];
    vi.mocked(requestForkSessionSetup).mockImplementation(async () => {
      callOrder.push("setup");
      return {
        workspaceRepoPath: "/local/repo",
        execution: {
          agentDefinitionId: "custom:security-auditor",
          accountId: "openai",
          model: "gpt-test",
        },
      };
    });
    loadFullTranscriptChunks.mockImplementation(async () => {
      callOrder.push("transcript");
      return [
        chunk("u1", "user_message", "user_message", {
          message: "old ask",
        }),
      ];
    });

    const sessionId = await forkExternalHistoryIntoOrgiiSession({
      sourceSessionId: "codexapp-source-1",
      sourceSession: {
        session_id: "codexapp-source-1",
        status: "completed",
        created_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
        name: "Imported review",
        repoPath: "/source/repo",
        model: "gpt-source",
      },
      userMessage: "continue and run tests",
      imageDataUrls: ["data:image/png;base64,abc"],
    });

    expect(sessionId).toBe("agentsession-forked");
    expect(callOrder).toEqual(["setup", "transcript"]);
    expect(resolveShareableScopeKeys).toHaveBeenCalledWith("/source/repo");
    expect(requestForkSessionSetup).toHaveBeenCalledWith({
      sourceTitle: "Imported review",
      sourceScopeKey: "github.com/org/repo",
      sourceModel: "gpt-source",
    });
    expect(SessionService.create).toHaveBeenCalledTimes(1);
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        imageDataUrls: ["data:image/png;base64,abc"],
        name: "Continue Imported review",
        repoPath: "/local/repo",
        model: "gpt-test",
        accountId: "openai",
        keySource: "own_key",
        agentDefinitionId: "custom:security-auditor",
        mode: "build",
        task: expect.stringContaining("continue and run tests"),
      })
    );
    expect(
      vi.mocked(SessionService.create).mock.calls[0]?.[0]
    ).not.toHaveProperty("parentSessionId");
  });

  it("dispatches the agent projection while userMessage stays the display copy", async () => {
    const contract =
      "[Canvas Creation Request]\nCreate a new interactive inline Canvas for the user request below. Call render_inline_canvas exactly once for the finished Canvas.\n\n[User Request]\nbuild a coffee order UI";

    await forkExternalHistoryIntoOrgiiSession({
      sourceSessionId: "codexapp-source-1",
      userMessage: "canvas [skill:/canvas] build a coffee order UI",
      agentMessage: contract,
    });

    const task = vi.mocked(SessionService.create).mock.calls[0]?.[0]?.task;
    // The handoff prompt embeds the AGENT copy as the continuation request —
    // never the raw pill serialization the display copy carries.
    expect(task).toContain("render_inline_canvas exactly once");
    expect(task).not.toContain("[skill:/canvas]");
  });

  it("falls back to the display copy when no agent projection exists", async () => {
    await forkExternalHistoryIntoOrgiiSession({
      sourceSessionId: "codexapp-source-1",
      userMessage: "continue and run tests",
    });

    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("continue and run tests"),
      })
    );
  });

  it("does not load or create anything when the shared setup is cancelled", async () => {
    vi.mocked(requestForkSessionSetup).mockRejectedValueOnce(
      new Error("cancelled")
    );

    await expect(
      forkExternalHistoryIntoOrgiiSession({
        sourceSessionId: "codexapp-source-1",
        userMessage: "continue",
      })
    ).rejects.toThrow("cancelled");
    expect(loadFullTranscriptChunks).not.toHaveBeenCalled();
    expect(SessionService.create).not.toHaveBeenCalled();
  });
});
