import { describe, expect, it, vi } from "vitest";

import {
  IMPORTED_HISTORY_SOURCES,
  getImportedHistoryAppOpen,
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
const genericLoaders = vi.hoisted(() => ({
  preview: vi.fn(),
}));

vi.mock("../../cursorIde", () => ({
  cursorIdeInitialWindow: cursorLoaders.preview,
  cursorIdeChunks: cursorLoaders.full,
}));

vi.mock("../../sources/codexApp", () => ({
  codexAppInitialWindow: codexLoaders.preview,
  codexAppChunks: codexLoaders.full,
}));

vi.mock("../window", () => ({
  importedHistoryInitialWindow: genericLoaders.preview,
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

  it("uses the bounded generic window without changing full cloud replay", async () => {
    genericLoaders.preview.mockResolvedValue({
      chunks: [{ id: "preview" }],
    });
    const claude = getImportedHistorySourceBySessionId(
      "claudecodeapp-session-1"
    );

    await expect(
      claude?.loadPreviewChunks("claudecodeapp-session-1")
    ).resolves.toEqual([{ id: "preview" }]);
    expect(genericLoaders.preview).toHaveBeenCalledWith({
      sessionId: "claudecodeapp-session-1",
      recentTurnCount: 1,
    });
    expect(claude?.loadFullTranscriptChunks).not.toBe(
      claude?.loadPreviewChunks
    );
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
      "pi",
      "qoder_cli",
      "qwen_code",
      "copilot",
      "kimi",
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
      "external_history:pi",
      "external_history:qoder_cli",
      "external_history:qwen_code",
      "external_history:copilot",
      "external_history:kimi",
    ]);
    for (const source of IMPORTED_HISTORY_SOURCES) {
      expect(source.loadPreviewChunks).toBeTypeOf("function");
      expect(source.loadFullTranscriptChunks).toBeTypeOf("function");
      expect(source.supportsWindowedReplay).toBe(true);
    }
  });

  it("enables bounded cloud replay only for providers with exact turn seeks", () => {
    const capable = IMPORTED_HISTORY_SOURCES.filter(
      (source) => source.loadCloudTurnIds && source.loadCloudTurnWindows
    ).map((source) => source.sourceId);
    expect(capable).toEqual(["cursor_ide", "codex_app", "claude_code"]);
  });

  it("advertises a native-app deep link only for the verified app routes", () => {
    // Mirrors the arms of `orgtrack_core::sources::app_open`: a source
    // appears here only once a per-session route was verified against the
    // shipped app. CLI-resumable is a separate axis — every entry here is
    // also CLI-resumable today, but neither implies the other.
    const linkable = IMPORTED_HISTORY_SOURCES.filter(
      (source) => source.appOpen
    ).map((source) => source.sourceId);
    expect(linkable).toEqual(["codex_app", "claude_code"]);
    expect(getImportedHistoryAppOpen("claudecodeapp-abc")).toEqual({
      displayName: "Claude",
      iconId: "claude",
    });
    expect(getImportedHistoryAppOpen("codexapp-abc")).toEqual({
      displayName: "Codex",
      iconId: "codex",
    });
    // Cursor's IDE composers and CLI chats have no per-chat deep link.
    expect(getImportedHistoryAppOpen("cursoride-abc")).toBeUndefined();
    expect(getImportedHistoryAppOpen("cursorcliapp-abc")).toBeUndefined();
    expect(getImportedHistoryAppOpen(null)).toBeUndefined();
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
      getImportedHistorySourceBySessionId("piapp-session-1")?.sourceId
    ).toBe("pi");
    expect(
      getImportedHistorySourceBySessionId("qodercliapp-session-1")?.sourceId
    ).toBe("qoder_cli");
    expect(
      getImportedHistorySourceBySessionId("qwencodeapp-session-1")?.sourceId
    ).toBe("qwen_code");
    expect(
      getImportedHistorySourceBySessionId("kimihistoryapp-cli/group/session")
        ?.sourceId
    ).toBe("kimi");
    expect(getImportedHistorySourceBySessionId("kimiapp-hook-session")).toBe(
      undefined
    );
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
    expect(
      getImportedHistorySourceByListCategory("external_history:pi")?.groupLabel
    ).toBe("Pi");
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
    expect(isImportedHistoryListCategory("external_history:pi")).toBe(true);
    expect(isImportedHistoryListCategory("external_history")).toBe(false);
  });
});
