import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  type UsageOverview,
  usageDashboardModelPricing,
  usageDashboardOverview,
} from ".";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("usageDashboardOverview", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue({
      summary: {},
      trends: [],
      rounds: [],
      roundTotal: 0,
      roundModels: [],
      hasUnknownRoundModel: false,
    });
  });

  it("passes the controlled request-log page and filters to Tauri", async () => {
    await usageDashboardOverview(
      {
        bucket: "codex",
        startMs: 100,
        endMs: 200,
        sessionId: "session-1",
      },
      {
        sort: "tokens",
        offset: 20,
        limit: 10,
        model: "gpt-5",
        search: "refactor",
      }
    );

    expect(invokeMock).toHaveBeenCalledWith("usage_dashboard_overview", {
      bucket: "codex",
      startMs: 100,
      endMs: 200,
      sessionId: "session-1",
      sort: "tokens",
      offset: 20,
      limit: 10,
      model: "gpt-5",
      unknownModel: false,
      search: "refactor",
      bucketUnit: null,
      includeHeadline: true,
      includeTrends: true,
      includeRounds: true,
    });
  });

  it("can omit request-table work for a headline-only load", async () => {
    await usageDashboardOverview({}, { includeRounds: false });

    expect(invokeMock).toHaveBeenCalledWith(
      "usage_dashboard_overview",
      expect.objectContaining({ includeRounds: false })
    );
  });

  it("can omit headline aggregation for a request-page load", async () => {
    await usageDashboardOverview({}, { includeHeadline: false });

    expect(invokeMock).toHaveBeenCalledWith(
      "usage_dashboard_overview",
      expect.objectContaining({ includeHeadline: false })
    );
  });

  it("can omit trend aggregation for a summary-only load", async () => {
    await usageDashboardOverview({}, { includeTrends: false });

    expect(invokeMock).toHaveBeenCalledWith(
      "usage_dashboard_overview",
      expect.objectContaining({ includeTrends: false })
    );
  });

  it("encodes the unknown-model filter without a contradictory model", async () => {
    await usageDashboardOverview({}, { unknownModel: true, limit: 10 });

    expect(invokeMock).toHaveBeenCalledWith(
      "usage_dashboard_overview",
      expect.objectContaining({
        model: null,
        unknownModel: true,
        offset: 0,
        limit: 10,
      })
    );
  });

  it("joins adjacent in-flight scope requests instead of starting parallel scans", async () => {
    let resolveOverview: ((value: UsageOverview) => void) | undefined;
    invokeMock.mockReturnValueOnce(
      new Promise<UsageOverview>((resolve) => {
        resolveOverview = resolve;
      })
    );

    const first = usageDashboardOverview(
      { startMs: 100, endMs: 10_001 },
      { includeRounds: false }
    );
    const second = usageDashboardOverview(
      { startMs: 100, endMs: 10_999 },
      { includeRounds: false }
    );
    expect(invokeMock).toHaveBeenCalledOnce();

    resolveOverview?.({
      summary: {} as UsageOverview["summary"],
      trends: [],
      rounds: [],
      roundTotal: 0,
      roundModels: [],
      hasUnknownRoundModel: false,
    });
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("evicts failed pricing promises so a retry can succeed", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        model: "retry-model",
        inputPerMtok: 1,
        outputPerMtok: 2,
        cacheReadPerMtok: 0,
        cacheWritePerMtok: 0,
      });

    await expect(
      usageDashboardModelPricing("retry-model")
    ).rejects.toThrowError("transient");
    await expect(
      usageDashboardModelPricing("retry-model")
    ).resolves.toMatchObject({ inputPerMtok: 1 });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
