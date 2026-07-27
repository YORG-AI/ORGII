import { describe, expect, it, vi } from "vitest";

import {
  IMPORTED_HISTORY_SOURCES,
  getImportedHistorySourceByListCategory,
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";

const cursorLoaders = vi.hoisted(() => ({
  preview: vi.fn(),
  full: vi.fn(),
}));
const codexLoaders = vi.hoisted(() => ({
  preview: vi.fn(),
  full: vi.fn(),
}));

vi.mock("../../cursorIde", () => ({
  cursorIdeInitialWindow: cursorLoaders.preview,
  cursorIdeChunks: cursorLoaders.full,
}));

vi.mock("../../sources/codexApp", () => ({
  codexAppInitialWindow: codexLoaders.preview,
  codexAppChunks: codexLoaders.full,
}));

describe("imported history source registry", () => {
  it("keeps Cursor's local preview window separate from cloud's full transcript", async () => {
    cursorLoaders.preview.mockResolvedValue({ chunks: [{ id: "preview" }] });
    cursorLoaders.full.mockResolvedValue([{ id: "full" }]);
    const cursor = getImportedHistorySourceBySessionId("cursoride-session-1");

    await expect(
      cursor?.loadPreviewChunks("cursoride-session-1")
    ).resolves.toEqual([{ id: "preview" }]);
    await expect(
      cursor?.loadFullTranscriptChunks("cursoride-session-1")
    ).resolves.toEqual([{ id: "full" }]);
    expect(cursorLoaders.preview).toHaveBeenCalledWith({
      sessionId: "cursoride-session-1",
      recentLimit: 100,
    });
    expect(cursorLoaders.full).toHaveBeenCalledWith("cursoride-session-1");
  });

  it("keeps Codex's bounded preview separate from cloud's full transcript", async () => {
    codexLoaders.preview.mockResolvedValue({ chunks: [{ id: "preview" }] });
    codexLoaders.full.mockResolvedValue([{ id: "full" }]);
    const codex = getImportedHistorySourceBySessionId("codexapp-session-1");

    await expect(
      codex?.loadPreviewChunks("codexapp-session-1")
    ).resolves.toEqual([{ id: "preview" }]);
    await expect(
      codex?.loadFullTranscriptChunks("codexapp-session-1")
    ).resolves.toEqual([{ id: "full" }]);
    expect(codexLoaders.preview).toHaveBeenCalledWith("codexapp-session-1");
    expect(codexLoaders.full).toHaveBeenCalledWith("codexapp-session-1");
  });

  it("registers source-specific external history providers", () => {
    expect(IMPORTED_HISTORY_SOURCES.map((source) => source.sourceId)).toEqual([
      "cursor_ide",
      "cursor_cli",
      "codex_app",
      "claude_code",
      "opencode",
      "windsurf",
      "workbuddy",
      "trae",
      "cline",
      "warp",
      "zcode",
      "qoder",
      "mimo_code",
      "omp",
      "qoder_cli",
    ]);
    expect(
      IMPORTED_HISTORY_SOURCES.map((source) => source.listCategory)
    ).toEqual([
      "external_history:cursor_ide",
      "external_history:cursor_cli",
      "external_history:codex_app",
      "external_history:claude_code",
      "external_history:opencode",
      "external_history:windsurf",
      "external_history:workbuddy",
      "external_history:trae",
      "external_history:cline",
      "external_history:warp",
      "external_history:zcode",
      "external_history:qoder",
      "external_history:mimo_code",
      "external_history:omp",
      "external_history:qoder_cli",
    ]);
    for (const source of IMPORTED_HISTORY_SOURCES) {
      expect(source.loadPreviewChunks).toBeTypeOf("function");
      expect(source.loadFullTranscriptChunks).toBeTypeOf("function");
    }
  });

  it("resolves source metadata by session id prefix", () => {
    expect(
      getImportedHistorySourceBySessionId("codexapp-rollout-1")?.sourceId
    ).toBe("codex_app");
    expect(
      getImportedHistorySourceBySessionId("claudecodeapp-session-1")?.sourceId
    ).toBe("claude_code");
    expect(
      getImportedHistorySourceBySessionId("opencodeapp-session-1")?.sourceId
    ).toBe("opencode");
    expect(
      getImportedHistorySourceBySessionId("windsurfapp-session-1")?.sourceId
    ).toBe("windsurf");
    expect(
      getImportedHistorySourceBySessionId("cursoride-session-1")?.sourceId
    ).toBe("cursor_ide");
    expect(
      getImportedHistorySourceBySessionId("workbuddyapp-session-1")?.sourceId
    ).toBe("workbuddy");
    expect(
      getImportedHistorySourceBySessionId("warpapp-session-1")?.sourceId
    ).toBe("warp");
    expect(
      getImportedHistorySourceBySessionId("mimocodeapp-session-1")?.sourceId
    ).toBe("mimo_code");
    expect(
      getImportedHistorySourceBySessionId("ompapp-session-1")?.sourceId
    ).toBe("omp");
    expect(
      getImportedHistorySourceBySessionId("qodercliapp-session-1")?.sourceId
    ).toBe("qoder_cli");
  });

  it("resolves source metadata by list category", () => {
    expect(
      getImportedHistorySourceByListCategory("external_history:cursor_ide")
        ?.groupLabel
    ).toBe("Cursor App");
    expect(
      getImportedHistorySourceByListCategory("external_history:codex_app")
        ?.groupLabel
    ).toBe("Codex App");
    expect(
      getImportedHistorySourceByListCategory("external_history:claude_code")
        ?.groupLabel
    ).toBe("Claude App");
    expect(
      getImportedHistorySourceByListCategory("external_history:opencode")
        ?.groupLabel
    ).toBe("OpenCode");
    expect(
      getImportedHistorySourceByListCategory("external_history:windsurf")
        ?.groupLabel
    ).toBe("Windsurf");
    expect(
      getImportedHistorySourceByListCategory("external_history:workbuddy")
        ?.groupLabel
    ).toBe("WorkBuddy");
    expect(
      getImportedHistorySourceByListCategory("external_history:warp")
        ?.groupLabel
    ).toBe("Warp");
  });

  it("narrows source-aware list categories", () => {
    expect(isImportedHistoryListCategory("external_history:cursor_ide")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:codex_app")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:claude_code")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:opencode")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:windsurf")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:workbuddy")).toBe(
      true
    );
    expect(isImportedHistoryListCategory("external_history:warp")).toBe(true);
    expect(isImportedHistoryListCategory("external_history")).toBe(false);
  });
});
