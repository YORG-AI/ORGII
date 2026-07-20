import { describe, expect, it } from "vitest";

import {
  IMPORTED_HISTORY_SOURCES,
  getImportedHistorySourceByListCategory,
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";

describe("imported history source registry", () => {
  it("registers source-specific external history providers", () => {
    expect(IMPORTED_HISTORY_SOURCES.map((source) => source.sourceId)).toEqual([
      "cursor_ide",
      "codex_app",
      "claude_code",
      "opencode",
      "windsurf",
      "workbuddy",
      "trae",
      "cline",
      "warp",
      "qoder",
    ]);
    expect(
      IMPORTED_HISTORY_SOURCES.map((source) => source.listCategory)
    ).toEqual([
      "external_history:cursor_ide",
      "external_history:codex_app",
      "external_history:claude_code",
      "external_history:opencode",
      "external_history:windsurf",
      "external_history:workbuddy",
      "external_history:trae",
      "external_history:cline",
      "external_history:warp",
      "external_history:qoder",
    ]);
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
      getImportedHistorySourceBySessionId("qoderapp-session-1")?.sourceId
    ).toBe("qoder");
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
      getImportedHistorySourceByListCategory("external_history:qoder")
        ?.groupLabel
    ).toBe("Qoder");
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
    expect(isImportedHistoryListCategory("external_history:qoder")).toBe(true);
    expect(isImportedHistoryListCategory("external_history")).toBe(false);
  });
});
