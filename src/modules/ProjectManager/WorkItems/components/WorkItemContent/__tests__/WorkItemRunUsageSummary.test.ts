import { describe, expect, it } from "vitest";

import type { WorkItemRun } from "@src/api/http/project";

import { summarizeWorkItemRuns } from "../WorkItemRunUsageSummary";

const run = (overrides: Partial<WorkItemRun["usage"]>): WorkItemRun => ({
  id: crypto.randomUUID(),
  orgId: "org-1",
  workItemId: "WI-0001",
  trigger: { kind: "manual" },
  targetSnapshot: {
    target: { kind: "resume_session", sessionId: "session-1" },
    workItemRevision: 1,
  },
  input: {},
  status: "succeeded",
  attempt: 1,
  maxAttempts: 3,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    ...overrides,
  },
  idempotencyKey: crypto.randomUUID(),
  createdAt: "2026-08-09T00:00:00Z",
  updatedAt: "2026-08-09T00:00:01Z",
});

describe("summarizeWorkItemRuns", () => {
  it("keeps billable and cache token dimensions visible", () => {
    expect(
      summarizeWorkItemRuns([
        run({
          inputTokens: 4,
          outputTokens: 973,
          cacheReadTokens: 34_458,
          cacheWriteTokens: 7_687,
          totalTokens: 977,
        }),
        run({
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          totalTokens: 30,
          costUsd: 0.25,
        }),
      ])
    ).toEqual({
      inputTokens: 14,
      outputTokens: 993,
      cacheReadTokens: 34_488,
      cacheWriteTokens: 7_727,
      totalTokens: 1_007,
      costUsd: 0.25,
    });
  });
});
