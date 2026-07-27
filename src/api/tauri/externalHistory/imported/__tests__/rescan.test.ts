import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  externalHistoryRescanSource,
  externalHistoryRescanSources,
} from "../../rescan";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("external history rescans", () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

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

  it("coalesces overlapping callers into one serialized source batch", async () => {
    await Promise.all([
      externalHistoryRescanSources(["codex_app", "cline"]),
      externalHistoryRescanSource("cline"),
    ]);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("external_history_rescan_sources", {
      sources: ["codex_app", "cline"],
      clear: false,
    });
  });

  it("escalates a queued source to one clear rebuild", async () => {
    await Promise.all([
      externalHistoryRescanSource("codex_app"),
      externalHistoryRescanSource("codex_app", { clear: true }),
    ]);

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("external_history_rescan_source", {
      source: "codex_app",
      clear: true,
    });
  });

  it("serializes a disjoint source behind the active native scan", async () => {
    const active = deferred<{ changedSources: ["codex_app"] }>();
    invokeMock
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce({ changedSources: ["cline"] });

    const first = externalHistoryRescanSource("codex_app");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());

    const second = externalHistoryRescanSource("cline");
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledOnce();

    active.resolve({ changedSources: ["codex_app"] });
    await first;
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toEqual({
      changedSources: ["cline"],
      sourceSignatures: {},
    });
    expect(invokeMock.mock.calls[1]).toEqual([
      "external_history_rescan_sources",
      { sources: ["cline"], clear: false },
    ]);
  });

  it("joins a same-source scan that is already active", async () => {
    const active = deferred<{ changedSources: ["codex_app"] }>();
    invokeMock.mockReturnValueOnce(active.promise);

    const first = externalHistoryRescanSource("codex_app");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    const joined = externalHistoryRescanSource("codex_app");

    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledOnce();

    active.resolve({ changedSources: ["codex_app"] });
    await expect(Promise.all([first, joined])).resolves.toEqual([
      { changedSources: ["codex_app"], sourceSignatures: {} },
      { changedSources: ["codex_app"], sourceSignatures: {} },
    ]);
  });

  it("queues a clear rebuild when an incremental scan is already active", async () => {
    const active = deferred<{ changedSources: [] }>();
    invokeMock
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce({ changedSources: ["codex_app"] });

    const incremental = externalHistoryRescanSource("codex_app");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());

    const rebuild = externalHistoryRescanSource("codex_app", { clear: true });
    await Promise.resolve();
    expect(invokeMock).toHaveBeenCalledOnce();

    active.resolve({ changedSources: [] });
    await incremental;
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await rebuild;
    expect(invokeMock.mock.calls[1]).toEqual([
      "external_history_rescan_source",
      { source: "codex_app", clear: true },
    ]);
  });

  it("releases the queue after a failed scan and continues with pending work", async () => {
    const active = deferred<{ changedSources: [] }>();
    invokeMock
      .mockReturnValueOnce(active.promise)
      .mockResolvedValueOnce({ changedSources: [] });

    const failed = externalHistoryRescanSource("codex_app");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledOnce());
    const pending = externalHistoryRescanSource("cline");

    active.reject(new Error("scan failed"));
    await expect(failed).rejects.toThrow("scan failed");
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    await expect(pending).resolves.toEqual({
      changedSources: [],
      sourceSignatures: {},
    });
  });
});
