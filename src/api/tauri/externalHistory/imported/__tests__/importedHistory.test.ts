import { describe, expect, it } from "vitest";

import type { ExternalCliSourceProbe } from "@src/api/tauri/externalHistory";

import {
  getDetectedExternalCliSourcesWithoutReplay,
  isImportedHistoryReplayableSourceId,
} from "../index";

function probe(sourceId: string, importable = false): ExternalCliSourceProbe {
  return {
    sourceId,
    displayName: sourceId,
    iconId: "terminal",
    detectCommands: [sourceId],
    launchCommand: sourceId,
    expectedProcess: sourceId,
    capabilities: {
      installedDetection: true,
      runningDetection: false,
      historyDetection: false,
      historyImport: importable,
    },
    installed: true,
    executablePath: null,
    running: null,
    historyFound: false,
    historyPaths: [],
    status: "detected_no_importer",
    importable,
    storeKind: "",
  };
}

describe("imported history source helpers", () => {
  it("recognizes replayable imported-history source ids", () => {
    expect(isImportedHistoryReplayableSourceId("codex_app")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("claude_code")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("warp")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("mimo_code")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("omp")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("pi")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("qoder_cli")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("qwen_code")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("copilot")).toBe(true);
    expect(isImportedHistoryReplayableSourceId("kimi")).toBe(true);
    expect(isImportedHistoryReplayableSourceId(null)).toBe(false);
  });

  it("filters detected external CLIs without replay support", () => {
    const filtered = getDetectedExternalCliSourcesWithoutReplay([
      probe("codex_app", true),
      probe("pi", true),
      probe("qwen_code", true),
      probe("copilot", true),
      probe("unsupported_cli"),
    ]);

    expect(filtered.map((item) => item.sourceId)).toEqual(["unsupported_cli"]);
  });
});
