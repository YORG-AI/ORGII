import { describe, expect, it, vi } from "vitest";

import type { AppMemorySnapshotV1 } from "./appMemorySnapshot";
import {
  getAppMemoryTotals,
  refreshAppMemorySnapshot,
} from "./appMemorySnapshot";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("app-memory snapshot store", () => {
  it("derives the top total only from the authoritative app snapshot", () => {
    const snapshot = {
      schema_version: 1,
      captured_at_ms: 123,
      processes: [
        {
          pid: 1,
          parent_pid: null,
          process_instance_id: "1:1",
          name: "ORG2 backend",
          role: "backend",
          effective_memory_bytes: 100,
          metric_kind: "physical_footprint",
          rss_bytes: 150,
        },
        {
          pid: 2,
          parent_pid: null,
          process_instance_id: "2:2",
          name: "WebView renderer",
          role: "renderer",
          effective_memory_bytes: 50,
          metric_kind: "physical_footprint",
          rss_bytes: 75,
        },
      ],
      effective_total_bytes: 150,
      rss_mapped_total_bytes: 225,
      measurement: "native",
      attribution: "complete",
      skipped_ambiguous_pids: [],
    } satisfies AppMemorySnapshotV1;

    expect(getAppMemoryTotals(snapshot)).toEqual({
      totalBytes: 150,
      backendBytes: 100,
      webviewHelperBytes: 50,
    });
  });

  it("shares one in-flight native snapshot request across consumers", async () => {
    let resolveRequest!: (snapshot: AppMemorySnapshotV1) => void;
    const request = new Promise<AppMemorySnapshotV1>((resolve) => {
      resolveRequest = resolve;
    });
    mocks.invoke.mockReturnValue(request);

    const first = refreshAppMemorySnapshot();
    const second = refreshAppMemorySnapshot();

    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("get_app_memory_snapshot_v1");

    const snapshot: AppMemorySnapshotV1 = {
      schema_version: 1,
      captured_at_ms: 123,
      processes: [],
      effective_total_bytes: 456,
      rss_mapped_total_bytes: 789,
      measurement: "native",
      attribution: "partial",
      skipped_ambiguous_pids: [42],
    };
    resolveRequest(snapshot);

    await expect(first).resolves.toBe(snapshot);
    await expect(second).resolves.toBe(snapshot);
  });
});
