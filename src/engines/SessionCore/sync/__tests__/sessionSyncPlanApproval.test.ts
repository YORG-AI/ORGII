import { describe, expect, it, vi } from "vitest";

import { getPendingPlanApproval } from "@src/api/tauri/agent";
import type { PlanApprovalStateMap } from "@src/store/session/planApprovalAtom";

import { rehydratePendingPlanApproval } from "../sessionSyncPlanApproval";

vi.mock("@src/api/tauri/agent", () => ({
  getPendingPlanApproval: vi.fn(),
}));

const mockedGetPending = vi.mocked(getPendingPlanApproval);

function existingState(): PlanApprovalStateMap {
  return new Map([
    [
      "session-1",
      {
        current: {
          sessionId: "session-1",
          planPath: "/plan.md",
          planTitle: "Plan",
          planContent: "stale",
          planRevisionId: "rev-1",
        },
      },
    ],
  ]);
}

async function flushRehydrate(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("rehydratePendingPlanApproval", () => {
  it("clears stale frontend state when the backend reports no pending plan", async () => {
    mockedGetPending.mockResolvedValueOnce(null);
    let state = existingState();

    rehydratePendingPlanApproval(
      "session-1",
      new AbortController(),
      (update) => {
        state = update(state);
      }
    );
    await flushRehydrate();

    expect(state.get("session-1")?.current).toBeNull();
  });

  it("refreshes content for the same authoritative backend revision", async () => {
    mockedGetPending.mockResolvedValueOnce({
      sessionId: "session-1",
      planPath: "/plan.md",
      planTitle: "Plan",
      planContent: "fresh",
      planRevisionId: "rev-1",
    });
    let state = existingState();

    rehydratePendingPlanApproval(
      "session-1",
      new AbortController(),
      (update) => {
        state = update(state);
      }
    );
    await flushRehydrate();

    expect(state.get("session-1")?.current?.planContent).toBe("fresh");
  });

  it("preserves a different live revision when rehydrate resolves late", async () => {
    mockedGetPending.mockResolvedValueOnce({
      sessionId: "session-1",
      planPath: "/plan.md",
      planTitle: "Plan",
      planContent: "older backend content",
      planRevisionId: "rev-2",
    });
    let state = existingState();

    rehydratePendingPlanApproval(
      "session-1",
      new AbortController(),
      (update) => {
        state = update(state);
      }
    );
    await flushRehydrate();

    expect(state.get("session-1")?.current?.planContent).toBe("stale");
  });
});
