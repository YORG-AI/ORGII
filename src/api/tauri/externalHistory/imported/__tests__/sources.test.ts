import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  IMPORTED_HISTORY_SOURCES,
  getImportedHistorySourceByListCategory,
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
  resolveExternalReplayTarget,
} from "@src/api/tauri/externalHistory";

function loadRustReplayRegistry(): Map<string, string> {
  const rustRoot = resolve(
    process.cwd(),
    "src-tauri/crates/orgtrack-core/src/sources"
  );
  const metadata = readFileSync(
    resolve(rustRoot, "imported_history/metadata.rs"),
    "utf8"
  );
  const sourceConstants = new Map<string, string>();
  for (const match of metadata.matchAll(
    /pub const (SOURCE_[A-Z0-9_]+):\s*&str\s*=\s*"([^"]+)"\s*;/g
  )) {
    sourceConstants.set(match[1], match[2]);
  }

  const registry = readFileSync(
    resolve(rustRoot, "imported_history/replay/registry.rs"),
    "utf8"
  );
  const descriptors = new Map<string, string>();
  for (const match of registry.matchAll(
    /source_id:\s*(SOURCE_[A-Z0-9_]+),\s*session_prefix:\s*(sources::[A-Za-z0-9_:]+),/g
  )) {
    const sourceId = sourceConstants.get(match[1]);
    if (!sourceId) throw new Error(`Unknown Rust source constant ${match[1]}`);

    const pathParts = match[2].split("::").slice(1);
    const constantName = pathParts.pop();
    if (!constantName) throw new Error(`Invalid Rust prefix path ${match[2]}`);
    const base = resolve(rustRoot, ...pathParts);
    const candidateFiles = [`${base}.rs`, resolve(base, "mod.rs")];
    const sourceFile = candidateFiles.find(existsSync);
    if (!sourceFile) {
      throw new Error(`Cannot resolve Rust prefix module ${match[2]}`);
    }
    const moduleSource = readFileSync(sourceFile, "utf8");
    const constantMatch = moduleSource.match(
      new RegExp(
        `(?:pub\\s+)?const\\s+${constantName}:\\s*&str\\s*=\\s*"([^"]+)"\\s*;`
      )
    );
    if (!constantMatch) {
      throw new Error(`Cannot resolve Rust prefix constant ${match[2]}`);
    }
    descriptors.set(sourceId, constantMatch[1]);
  }
  return descriptors;
}

describe("imported history source registry", () => {
  it("routes ORGII collaboration snapshots without adding a sixteenth vendor source", () => {
    expect(
      resolveExternalReplayTarget("imported-session-0123456789abcdef")
    ).toEqual({
      sourceId: "collaboration_snapshot",
      sessionId: "imported-session-0123456789abcdef",
    });
    expect(resolveExternalReplayTarget("sdeagent-native-1")).toBeNull();
    expect(resolveExternalReplayTarget("agentsession-cloud-fork-1")).toBeNull();
  });

  it("keeps the renderer metadata mirror exhaustive with the Rust authority", () => {
    const rust = loadRustReplayRegistry();
    const renderer = new Map(
      IMPORTED_HISTORY_SOURCES.map((source) => [source.sourceId, source.prefix])
    );

    expect(rust.size).toBe(15);
    expect([...renderer.entries()].sort()).toEqual([...rust.entries()].sort());
  });

  it("does not expose a renderer-side full transcript fallback", () => {
    const cursor = getImportedHistorySourceBySessionId("cursoride-session-1");
    expect(cursor).toBeDefined();
    expect(cursor).not.toHaveProperty("loadPreviewChunks");
    expect(cursor).not.toHaveProperty("loadFullTranscriptChunks");
    expect(cursor).not.toHaveProperty("statTranscript");
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
      expect(source).not.toHaveProperty("loadPreviewChunks");
      expect(source).not.toHaveProperty("loadFullTranscriptChunks");
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
