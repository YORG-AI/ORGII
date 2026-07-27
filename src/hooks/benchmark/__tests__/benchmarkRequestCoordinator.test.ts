import { beforeEach, describe, expect, it, vi } from "vitest";

import { benchmarkApi } from "@src/api/tauri/benchmark";

import {
  __TESTS_ONLY,
  getBenchmarkAgentBatchStatusShared,
  listBenchmarkTasksShared,
  setBenchmarkAgentBatchStatusShared,
} from "../benchmarkRequestCoordinator";

vi.mock("@src/api/tauri/benchmark", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@src/api/tauri/benchmark")>();
  return {
    ...original,
    benchmarkApi: {
      ...original.benchmarkApi,
      getAgentBatchStatus: vi.fn(),
      listTasks: vi.fn(),
    },
  };
});

describe("benchmark request coordinator", () => {
  beforeEach(() => {
    __TESTS_ONLY.reset();
    vi.mocked(benchmarkApi.getAgentBatchStatus).mockReset();
    vi.mocked(benchmarkApi.listTasks).mockReset();
  });

  it("shares task discovery across hook instances", async () => {
    vi.mocked(benchmarkApi.listTasks).mockResolvedValue([]);
    const request = {
      kind: "swe_bench_pro" as const,
      sourcePath: "/bench",
      limit: 250,
    };

    await Promise.all([
      listBenchmarkTasksShared(request),
      listBenchmarkTasksShared(request),
    ]);

    expect(benchmarkApi.listTasks).toHaveBeenCalledTimes(1);
  });

  it("shares an active status request and reuses it within one poll period", async () => {
    const status = {
      batchId: "batch-1",
      status: "running",
    };
    vi.mocked(benchmarkApi.getAgentBatchStatus).mockResolvedValue(
      status as Awaited<ReturnType<typeof benchmarkApi.getAgentBatchStatus>>
    );

    await Promise.all([
      getBenchmarkAgentBatchStatusShared("batch-1"),
      getBenchmarkAgentBatchStatusShared("batch-1"),
    ]);
    await getBenchmarkAgentBatchStatusShared("batch-1");

    expect(benchmarkApi.getAgentBatchStatus).toHaveBeenCalledTimes(1);
  });

  it("releases a failed request for retry", async () => {
    vi.mocked(benchmarkApi.getAgentBatchStatus)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        batchId: "batch-1",
        status: "running",
      } as Awaited<ReturnType<typeof benchmarkApi.getAgentBatchStatus>>);

    await expect(getBenchmarkAgentBatchStatusShared("batch-1")).rejects.toThrow(
      "offline"
    );
    await expect(
      getBenchmarkAgentBatchStatusShared("batch-1")
    ).resolves.toBeTruthy();

    expect(benchmarkApi.getAgentBatchStatus).toHaveBeenCalledTimes(2);
  });

  it("does not expose an older poll response after a mutation seeds status", async () => {
    type AgentStatus = Awaited<
      ReturnType<typeof benchmarkApi.getAgentBatchStatus>
    >;
    let release!: (status: AgentStatus) => void;
    vi.mocked(benchmarkApi.getAgentBatchStatus).mockImplementation(
      () =>
        new Promise<AgentStatus>((resolve) => {
          release = resolve;
        })
    );
    const running = { batchId: "batch-1", status: "running" } as AgentStatus;
    const cancelled = {
      batchId: "batch-1",
      status: "cancelled",
    } as AgentStatus;

    const poll = getBenchmarkAgentBatchStatusShared("batch-1");
    setBenchmarkAgentBatchStatusShared(cancelled);
    release(running);

    await expect(poll).resolves.toBe(cancelled);
    await expect(getBenchmarkAgentBatchStatusShared("batch-1")).resolves.toBe(
      cancelled
    );
    expect(benchmarkApi.getAgentBatchStatus).toHaveBeenCalledTimes(1);
  });
});
