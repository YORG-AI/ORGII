import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchExternalSourceStats,
  fetchExternalSourceStatsBatch,
} from "./sourceStats";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("external history source stats", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue([
      {
        sourceId: "codex_app",
        sessionCount: 12,
        subagentCount: 2,
        lastUsedAt: "2026-07-23T01:02:03+00:00",
      },
      {
        sourceId: "cline",
        sessionCount: 3,
        subagentCount: 0,
        lastUsedAt: null,
      },
    ]);
  });

  it("reads multiple cached source counters through one IPC", async () => {
    const stats = await fetchExternalSourceStatsBatch(["codex_app", "cline"]);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("external_history_source_stats", {
      sources: ["codex_app", "cline"],
    });
    expect(stats.get("codex_app")).toMatchObject({
      sessionCount: 12,
      subagentCount: 2,
    });
  });

  it("keeps the single-source convenience cache-only", async () => {
    const stats = await fetchExternalSourceStats("codex_app");

    expect(invokeMock).toHaveBeenCalledWith("external_history_source_stats", {
      sources: ["codex_app"],
    });
    expect(stats.sessionCount).toBe(12);
  });
});
