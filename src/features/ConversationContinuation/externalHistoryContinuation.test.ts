// @vitest-environment node
import { exists } from "@tauri-apps/plugin-fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ImportedHistorySource,
  externalHistoryCliResumePlan,
  getImportedHistorySourceBySessionId,
} from "@src/api/tauri/externalHistory";

import {
  resolveExternalHistoryContinuation,
  resolveExternalHistoryContinuationSource,
  resolveExternalHistoryWorkspace,
} from "./externalHistoryContinuation";

vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn() }));
vi.mock("@src/api/tauri/externalHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@src/api/tauri/externalHistory")>()),
  externalHistoryCliResumePlan: vi.fn(),
  getImportedHistorySourceBySessionId: vi.fn(),
}));

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
  cliResume: { agentType: "codex", displayName: "Codex" },
  dispatchCategory: "external_history",
  loadPreviewChunks: vi.fn(),
  loadFullTranscriptChunks: vi.fn(),
};

const target = {
  cliAgentType: "codex",
  accountId: "codex-local",
  model: "gpt-test",
  workspaceRepoPath: "/local/repo",
} as const;

describe("external history continuation resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImportedHistorySourceBySessionId).mockReturnValue(source);
    vi.mocked(externalHistoryCliResumePlan).mockResolvedValue(null);
    vi.mocked(exists).mockResolvedValue(true);
  });

  it("returns only canonical identity, title, and a device-valid target", async () => {
    await expect(
      resolveExternalHistoryContinuation({
        sourceSessionId: "codexapp-source-1",
        sourceSession: {
          session_id: "codexapp-source-1",
          status: "completed",
          created_at: "2026-07-13T00:00:00Z",
          updated_at: "2026-07-13T00:00:00Z",
          name: "Imported review",
        },
        target,
      })
    ).resolves.toEqual({
      title: "Continue Imported review",
      target,
    });
  });

  it("uses the imported native cwd without exposing its provider UUID", async () => {
    vi.mocked(externalHistoryCliResumePlan).mockResolvedValueOnce({
      source: "claude_code",
      cliAgentType: "claude_code",
      defaultBinary: "claude",
      resumeArgs: ["--resume", "native-source-id"],
      nativeSessionId: "00000000-0000-4000-8000-000000000456",
      cwd: "/source/repo",
      requiresCwd: true,
      displayCommand: "claude --resume native-source-id",
      cwdExists: true,
      sourceAvailable: true,
    });

    const resolved = await resolveExternalHistoryContinuation({
      sourceSessionId: "codexapp-source-1",
      target: { ...target, workspaceRepoPath: null },
    });

    expect(resolved.target.workspaceRepoPath).toBe("/source/repo");
    expect(JSON.stringify(resolved)).not.toContain("native-source-id");
  });

  it("falls back to the current workspace when imported paths are stale", async () => {
    vi.mocked(externalHistoryCliResumePlan).mockResolvedValueOnce({
      source: "claude_code",
      cliAgentType: "claude_code",
      defaultBinary: "claude",
      resumeArgs: ["--resume", "native-source-id"],
      nativeSessionId: "00000000-0000-4000-8000-000000000456",
      cwd: "/deleted/source",
      requiresCwd: true,
      displayCommand: "claude --resume native-source-id",
      cwdExists: false,
      sourceAvailable: true,
    });
    vi.mocked(exists).mockImplementation(
      async (path) => path === "/current/repo"
    );

    const resolved = await resolveExternalHistoryContinuation({
      sourceSessionId: "codexapp-source-1",
      target: { ...target, workspaceRepoPath: "/deleted/remembered" },
      fallbackWorkspaceRepoPath: "/current/repo",
    });

    expect(resolved.target.workspaceRepoPath).toBe("/current/repo");
  });

  it("drops all stale paths instead of launching in a missing cwd", async () => {
    await expect(
      resolveExternalHistoryWorkspace({
        selectedPath: "/deleted/remembered",
        sourcePath: "/deleted/source",
        fallbackPath: "/deleted/current",
        pathExists: async () => false,
      })
    ).resolves.toBeNull();
  });

  it("reads only cwd from the provider resume plan", async () => {
    vi.mocked(externalHistoryCliResumePlan).mockResolvedValueOnce({
      source: "codex_app",
      cliAgentType: "codex",
      defaultBinary: "codex",
      resumeArgs: ["resume", "native-source-id"],
      nativeSessionId: "00000000-0000-4000-8000-000000000123",
      cwd: "/source/repo",
      requiresCwd: false,
      displayCommand: "codex resume native-source-id",
      cwdExists: true,
      sourceAvailable: true,
    });

    await expect(
      resolveExternalHistoryContinuationSource("codexapp-source-1")
    ).resolves.toEqual({ cwd: "/source/repo" });
  });

  it("rejects an unregistered imported source", async () => {
    vi.mocked(getImportedHistorySourceBySessionId).mockReturnValue(undefined);
    await expect(
      resolveExternalHistoryContinuation({
        sourceSessionId: "missing",
        target,
      })
    ).rejects.toThrow("No imported-history source is registered");
  });
});
