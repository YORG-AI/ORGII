import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ImportedHistorySource,
  getImportedHistorySourceBySessionId,
} from "@src/api/tauri/externalHistory";
import { externalReplayHandoff } from "@src/api/tauri/externalHistory/replay";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";

import {
  buildExternalHistoryHandoffPromptFromItems,
  forkExternalHistoryIntoOrgiiSession,
} from "./externalHistoryFork";

vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId: vi.fn(),
}));
vi.mock("@src/api/tauri/externalHistory/replay", () => ({
  externalReplayHandoff: vi.fn(),
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

describe("buildExternalHistoryHandoffPrompt", () => {
  it("wraps backend-folded semantic items in the existing safety prompt", () => {
    const prompt = buildExternalHistoryHandoffPromptFromItems(
      [
        "User: fix the sync",
        "[Imported Claude App action]\nTool: read_file\nResult at that time: old file",
        "Assistant: I found the issue",
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
    expect(prompt).toContain(
      "Reasoning/thinking chunks were intentionally skipped."
    );
  });
});

describe("forkExternalHistoryIntoOrgiiSession", () => {
  const source: ImportedHistorySource = {
    sourceId: "codex_app",
    listCategory: "external_history:codex_app",
    prefix: "codexapp-",
    iconId: "codex",
    displayName: "Codex App",
    groupLabel: "Codex App",
    listable: true,
    replayable: true,
    dispatchCategory: "external_history",
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
    vi.mocked(externalReplayHandoff).mockResolvedValue({
      items: ["User: old ask"],
      generation: "generation-1",
      scannedBytes: 1024,
      scannedEvents: 1,
    });
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
    vi.mocked(externalReplayHandoff).mockImplementation(async () => {
      callOrder.push("transcript");
      return {
        items: ["User: old ask"],
        generation: "generation-1",
        scannedBytes: 1024,
        scannedEvents: 1,
      };
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
    expect(externalReplayHandoff).toHaveBeenCalledWith({
      sessionId: "codexapp-source-1",
      sourceName: "Codex App",
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
    expect(externalReplayHandoff).not.toHaveBeenCalled();
    expect(SessionService.create).not.toHaveBeenCalled();
  });

  it("uses the backend's already-paged handoff items without receiving SessionEvents", async () => {
    vi.mocked(externalReplayHandoff).mockResolvedValueOnce({
      items: ["User: usable older ask", "Assistant: current answer"],
      generation: "generation-1",
      scannedBytes: 4096,
      scannedEvents: 12,
    });

    await forkExternalHistoryIntoOrgiiSession({
      sourceSessionId: "codexapp-source-1",
      userMessage: "continue",
    });

    expect(externalReplayHandoff).toHaveBeenCalledTimes(1);
    expect(SessionService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("usable older ask"),
      })
    );
  });
});
