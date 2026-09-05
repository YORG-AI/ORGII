import { describe, expect, it } from "vitest";

import {
  RETENTION_POOLS,
  getTabRetentionPool,
  isRetainedTabType,
  isTabInRetentionPool,
  selectRetentionPoolTabIds,
} from "../tabRetention";
import type { WorkStationTabType } from "../types";

describe("tabRetention policy", () => {
  it("preserves the pinned Review tab in its own single-slot pool", () => {
    expect(getTabRetentionPool("source-control")).toBe(
      RETENTION_POOLS["source-control"]
    );
    expect(RETENTION_POOLS["source-control"].maxWarm).toBe(1);
    expect(isRetainedTabType("source-control")).toBe(true);
  });

  it("preserves the Project Manager list trio in one shared pool", () => {
    for (const type of [
      "project-workitems",
      "project-linear-projects",
      "project-linear-work-items",
    ] as const) {
      expect(getTabRetentionPool(type)?.id).toBe("project-trio");
    }
    expect(RETENTION_POOLS["project-trio"].maxWarm).toBe(2);
  });

  it("rebuilds everything else by default", () => {
    const rebuilt: WorkStationTabType[] = [
      "file",
      "git-diff",
      "terminal",
      "browser-session",
      "chat-session",
      "github-pr-detail",
      "search",
    ];
    for (const type of rebuilt) {
      expect(isRetainedTabType(type)).toBe(false);
      expect(getTabRetentionPool(type)).toBeNull();
    }
  });

  it("bounds every pool with a finite grace and a positive warm cap", () => {
    for (const pool of Object.values(RETENTION_POOLS)) {
      expect(Number.isFinite(pool.graceMs)).toBe(true);
      expect(pool.maxWarm).toBeGreaterThan(0);
    }
  });

  it("selects only a pool's tabs, in pane order", () => {
    const tabs = [
      { id: "file:a", type: "file" as const },
      { id: "project-workitems:1", type: "project-workitems" as const },
      { id: "source-control:changes", type: "source-control" as const },
      {
        id: "project-linear-projects:1",
        type: "project-linear-projects" as const,
      },
    ];
    expect(selectRetentionPoolTabIds(tabs, "project-trio")).toEqual([
      "project-workitems:1",
      "project-linear-projects:1",
    ]);
    expect(selectRetentionPoolTabIds(tabs, "source-control")).toEqual([
      "source-control:changes",
    ]);
    expect(isTabInRetentionPool(tabs[0], "source-control")).toBe(false);
  });
});
