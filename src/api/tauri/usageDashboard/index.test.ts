import { beforeEach, describe, expect, it, vi } from "vitest";

import { usageDashboardOverview } from ".";

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
});
