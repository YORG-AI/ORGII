import { describe, expect, it } from "vitest";

import type { ContextCacheSnapshotResult } from "@src/api/tauri/agent/contextCacheSnapshot";

function panelMetrics(snapshot: ContextCacheSnapshotResult | null) {
  const latest = snapshot?.latestCacheLayout;
  return {
    stablePrefixTokens: latest?.stablePrefixTokens ?? 0,
    volatileContextTokens: latest?.volatileContextTokens ?? 0,
    importedContextCount:
      latest?.importedContextCount ?? snapshot?.snapshots.length ?? 0,
    providerCachePercent:
      latest?.providerCacheHitRate != null
        ? Math.round(latest.providerCacheHitRate * 100)
        : null,
    namespaces: (snapshot?.snapshots ?? []).map((item) => item.namespace),
    embeddedSequence: snapshot?.embeddingState?.lastEmbeddedSequence ?? null,
  };
}

describe("context cache debug panel metrics", () => {
  it("prefers backend cache-layout counts over raw snapshot count", () => {
    const snapshot: ContextCacheSnapshotResult = {
      sessionId: "session-a",
      snapshots: [
        {
          snapshotId: "snap-1",
          targetSessionId: "session-a",
          sourceKind: "work_item",
          sourceId: "WI-1",
          namespace: "work_item:WI-1",
          tokenEstimate: 100,
          pinned: true,
          createdAt: "2026-06-29T00:00:00Z",
        },
      ],
      latestCacheLayout: {
        stablePrefixTokens: 1200,
        volatileContextTokens: 300,
        importedContextCount: 4,
        cacheReadTokens: 900,
        cacheWriteTokens: 100,
        providerCacheHitRate: 0.9,
      },
      embeddingState: {
        namespace: "session:session-a",
        sessionId: "session-a",
        workItemId: "WI-1",
        lastEmbeddedSequence: 42,
        embeddingModel: "test-model",
        updatedAt: "2026-06-29T00:00:01Z",
      },
    };

    expect(panelMetrics(snapshot)).toEqual({
      stablePrefixTokens: 1200,
      volatileContextTokens: 300,
      importedContextCount: 4,
      providerCachePercent: 90,
      namespaces: ["work_item:WI-1"],
      embeddedSequence: 42,
    });
  });

  it("falls back to raw snapshot count before the first cache-layout row exists", () => {
    const snapshot: ContextCacheSnapshotResult = {
      sessionId: "session-a",
      snapshots: [
        {
          snapshotId: "snap-1",
          targetSessionId: "session-a",
          sourceKind: "session",
          sourceId: "source-session",
          namespace: "session:source-session",
          tokenEstimate: 0,
          pinned: false,
          createdAt: "2026-06-29T00:00:00Z",
        },
      ],
      latestCacheLayout: null,
      embeddingState: null,
    };

    expect(panelMetrics(snapshot)).toMatchObject({
      stablePrefixTokens: 0,
      volatileContextTokens: 0,
      importedContextCount: 1,
      providerCachePercent: null,
      namespaces: ["session:source-session"],
      embeddedSequence: null,
    });
  });
});
