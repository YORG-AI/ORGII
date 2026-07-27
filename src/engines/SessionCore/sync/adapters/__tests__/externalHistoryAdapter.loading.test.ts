import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityChunk } from "@src/types/session/session";

import {
  forgetTranscriptSignature,
  getTranscriptSignature,
} from "../../externalHistoryTranscriptSignatures";
import { externalHistoryAdapter } from "../externalHistoryAdapter";

const mocks = vi.hoisted(() => ({
  getSource: vi.fn(),
  processChunks: vi.fn(),
}));

vi.mock("@src/api/tauri/externalHistory", () => ({
  getImportedHistorySourceBySessionId: mocks.getSource,
}));

vi.mock("@src/engines/SessionCore/ingestion/rustBridge", () => ({
  processChunksRust: mocks.processChunks,
}));

function chunk(): ActivityChunk {
  return {
    chunk_id: "chunk-1",
    action_type: "raw",
    function: "user_message",
    args: {},
    result: {},
    created_at: "2026-07-22T12:00:00.000Z",
  };
}

describe("external history loading", () => {
  beforeEach(() => {
    mocks.getSource.mockReset();
    mocks.processChunks.mockReset();
    forgetTranscriptSignature("codexapp-large");
  });

  it("shares one parse across overlapping initial and refresh loads", async () => {
    let resolveChunks: ((chunks: ActivityChunk[]) => void) | undefined;
    const loadPreviewChunks = vi.fn(
      () =>
        new Promise<ActivityChunk[]>((resolve) => {
          resolveChunks = resolve;
        })
    );
    const statTranscript = vi
      .fn()
      .mockResolvedValue({ mtimeMs: 100, sizeBytes: 200 });
    mocks.getSource.mockReturnValue({
      supportsWindowedReplay: true,
      statTranscript,
      loadPreviewChunks,
    });
    const events = [{ id: "event-1" }];
    mocks.processChunks.mockResolvedValue(events);

    const first = externalHistoryAdapter.loadHistory(
      "codexapp-large",
      new AbortController().signal
    );
    const second = externalHistoryAdapter.loadHistory(
      "codexapp-large",
      new AbortController().signal
    );

    await vi.waitFor(() => expect(loadPreviewChunks).toHaveBeenCalledTimes(1));
    resolveChunks?.([chunk()]);

    await expect(Promise.all([first, second])).resolves.toEqual([
      events,
      events,
    ]);
    expect(mocks.processChunks).toHaveBeenCalledTimes(1);
    expect(statTranscript).toHaveBeenCalledTimes(2);
    expect(getTranscriptSignature("codexapp-large")).toBe("100:200");
  });

  it("does not let one aborted consumer cancel the shared snapshot", async () => {
    let resolveChunks: ((chunks: ActivityChunk[]) => void) | undefined;
    const loadPreviewChunks = vi.fn(
      () =>
        new Promise<ActivityChunk[]>((resolve) => {
          resolveChunks = resolve;
        })
    );
    mocks.getSource.mockReturnValue({
      loadPreviewChunks,
      statTranscript: vi
        .fn()
        .mockResolvedValue({ mtimeMs: 100, sizeBytes: 200 }),
    });
    const events = [{ id: "event-1" }];
    mocks.processChunks.mockResolvedValue(events);
    const cancelled = new AbortController();

    const first = externalHistoryAdapter.loadHistory(
      "codexapp-large",
      cancelled.signal
    );
    const second = externalHistoryAdapter.loadHistory(
      "codexapp-large",
      new AbortController().signal
    );
    cancelled.abort();
    await vi.waitFor(() => expect(loadPreviewChunks).toHaveBeenCalledTimes(1));
    resolveChunks?.([chunk()]);

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual(events);
    expect(mocks.processChunks).toHaveBeenCalledTimes(1);
  });

  it("reuses an observed signature and only probes once after parsing", async () => {
    const loadPreviewChunks = vi.fn().mockResolvedValue([chunk()]);
    const statTranscript = vi
      .fn()
      .mockResolvedValue({ mtimeMs: 100, sizeBytes: 200 });
    mocks.getSource.mockReturnValue({
      supportsWindowedReplay: true,
      statTranscript,
      loadPreviewChunks,
    });
    const events = [{ id: "event-1" }];
    mocks.processChunks.mockResolvedValue(events);

    await expect(
      externalHistoryAdapter.loadHistoryFromObservedSignature!(
        "codexapp-large",
        new AbortController().signal,
        "100:200"
      )
    ).resolves.toEqual(events);

    expect(loadPreviewChunks).toHaveBeenCalledTimes(1);
    expect(statTranscript).toHaveBeenCalledTimes(1);
    expect(getTranscriptSignature("codexapp-large")).toBe("100:200");
  });

  it("keeps a changed transcript eligible for another refresh", async () => {
    mocks.getSource.mockReturnValue({
      supportsWindowedReplay: true,
      statTranscript: vi
        .fn()
        .mockResolvedValue({ mtimeMs: 101, sizeBytes: 250 }),
      loadPreviewChunks: vi.fn().mockResolvedValue([chunk()]),
    });
    mocks.processChunks.mockResolvedValue([{ id: "event-1" }]);

    await externalHistoryAdapter.loadHistoryFromObservedSignature(
      "codexapp-large",
      new AbortController().signal,
      "100:200"
    );

    expect(getTranscriptSignature("codexapp-large")).toBeUndefined();
  });

  it("remembers a stable empty transcript instead of reloading it forever", async () => {
    const statTranscript = vi
      .fn()
      .mockResolvedValue({ mtimeMs: 100, sizeBytes: 0 });
    mocks.getSource.mockReturnValue({
      supportsWindowedReplay: true,
      statTranscript,
      loadPreviewChunks: vi.fn().mockResolvedValue([]),
    });

    await expect(
      externalHistoryAdapter.loadHistoryFromObservedSignature(
        "codexapp-large",
        new AbortController().signal,
        "100:0"
      )
    ).resolves.toEqual([]);

    expect(statTranscript).toHaveBeenCalledTimes(1);
    expect(mocks.processChunks).not.toHaveBeenCalled();
    expect(getTranscriptSignature("codexapp-large")).toBe("100:0");
  });
});
