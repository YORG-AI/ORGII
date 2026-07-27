import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __TESTS_ONLY,
  externalHistoryRescanSource,
  externalHistoryRescanSources,
} from "../../rescan";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("external history rescans", () => {
  beforeEach(() => {
    __TESTS_ONLY.reset();
    invokeMock.mockReset().mockResolvedValue(undefined);
  });

  it("rescans multiple sources through one IPC command", async () => {
    await externalHistoryRescanSources(["codex_app", "cline"]);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("external_history_rescan_sources", {
      sources: ["codex_app", "cline"],
      clear: false,
    });
  });

  it("keeps the single-source clear operation available", async () => {
    await externalHistoryRescanSource("codex_app", { clear: true });

    expect(invokeMock).toHaveBeenCalledWith("external_history_rescan_source", {
      source: "codex_app",
      clear: true,
    });
  });

  it("does not invoke the backend for an empty source set", async () => {
    await externalHistoryRescanSources([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shares overlapping single-source and batch rescans", async () => {
    let release!: () => void;
    invokeMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const batch = externalHistoryRescanSources(["codex_app", "cline"]);
    const single = externalHistoryRescanSource("codex_app");

    expect(invokeMock).toHaveBeenCalledOnce();
    release();
    await Promise.all([batch, single]);
    expect(__TESTS_ONLY.activeRescanCount()).toBe(0);
  });

  it("queues one clear pass behind an active incremental rescan", async () => {
    let releaseIncremental!: () => void;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseIncremental = resolve;
          })
      )
      .mockResolvedValueOnce(undefined);

    const incremental = externalHistoryRescanSource("codex_app");
    const firstClear = externalHistoryRescanSource("codex_app", {
      clear: true,
    });
    const secondClear = externalHistoryRescanSource("codex_app", {
      clear: true,
    });

    expect(invokeMock).toHaveBeenCalledTimes(1);
    releaseIncremental();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await Promise.all([incremental, firstClear, secondClear]);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "external_history_rescan_source",
      { source: "codex_app", clear: true }
    );
  });

  it("releases failed rescans so the next request can retry", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce(undefined);

    await expect(externalHistoryRescanSource("codex_app")).rejects.toThrow(
      "scan failed"
    );
    await expect(
      externalHistoryRescanSource("codex_app")
    ).resolves.toBeUndefined();

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
