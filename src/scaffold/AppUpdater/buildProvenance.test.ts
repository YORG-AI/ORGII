import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatAppBuildRevision,
  getAppBuildProvenance,
  resetAppBuildProvenanceForTests,
} from "./buildProvenance";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("app build provenance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAppBuildProvenanceForTests();
  });

  it("loads the native provenance once and preserves its typed install strategy", async () => {
    const provenance = {
      kind: "local" as const,
      gitRef: "codex/durable-workitem-runs",
      gitSha: "1234567890abcdef",
      installStrategy: "separateMacosApplication" as const,
    };
    mocks.invoke.mockResolvedValue(provenance);

    await expect(getAppBuildProvenance()).resolves.toEqual(provenance);
    await expect(getAppBuildProvenance()).resolves.toEqual(provenance);

    expect(mocks.invoke).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("get_app_build_provenance");
    expect(formatAppBuildRevision(provenance)).toBe(
      "codex/durable-workitem-runs@12345678"
    );
  });
});
