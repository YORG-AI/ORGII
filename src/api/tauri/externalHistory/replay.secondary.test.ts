import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveExternalReplayTarget,
  resolveSecondaryReplayTarget,
} from "./replay";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
}));

vi.mock("@src/api/tauri/collaborationSnapshotIngest", () => ({
  collaborationSnapshotSecondaryProbe: mocks.probe,
}));

describe("secondary replay target resolution", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.probe.mockResolvedValue(false);
  });

  it("keeps native Agent sessions out of the primary replay registry", () => {
    expect(resolveExternalReplayTarget("agentsession-cloud-fork")).toBeNull();
    expect(resolveExternalReplayTarget("sdeagent-native")).toBeNull();
  });

  it("admits an agentsession fork only after the Rust snapshot probe succeeds", async () => {
    mocks.probe.mockResolvedValue(true);

    await expect(
      resolveSecondaryReplayTarget("agentsession-cloud-fork")
    ).resolves.toEqual({
      sourceId: "collaboration_snapshot",
      sessionId: "agentsession-cloud-fork",
    });
    expect(mocks.probe).toHaveBeenCalledOnce();
    expect(mocks.probe).toHaveBeenCalledWith("agentsession-cloud-fork");
  });

  it("falls back to the ordinary native path when the snapshot proof is absent", async () => {
    await expect(
      resolveSecondaryReplayTarget("agentsession-native")
    ).resolves.toBeNull();
    expect(mocks.probe).toHaveBeenCalledWith("agentsession-native");
  });

  it("never probes SDE or already registered external sessions", async () => {
    await expect(
      resolveSecondaryReplayTarget("sdeagent-native")
    ).resolves.toBeNull();
    await expect(
      resolveSecondaryReplayTarget("codexapp-session-1")
    ).resolves.toEqual({
      sourceId: "codex_app",
      sessionId: "codexapp-session-1",
    });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
});
