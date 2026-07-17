import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { createSourceControlQuickActions } from "../config";

const labels: Record<string, string> = {
  "sourceControl.emptyState.viewSourceControl": "View Source Control",
  "sourceControl.emptyState.viewIssues": "View Issues",
  "sourceControl.emptyState.viewGitHistory": "View Git history",
  "sourceControl.emptyState.viewPullRequests": "View PRs",
};

const t = ((key: string) => labels[key] ?? key) as unknown as TFunction;

describe("createSourceControlQuickActions", () => {
  it("omits Source Control while showing its other destinations", () => {
    const actions = createSourceControlQuickActions({
      t,
      activeMode: "uncommitted",
      onNavigate: vi.fn(),
    });

    expect(actions.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: "view-issues", label: "View Issues" },
      { id: "view-git-history", label: "View Git history" },
      { id: "view-pull-requests", label: "View PRs" },
    ]);
  });

  it.each([
    ["history", "view-git-history"],
    ["issues", "view-issues"],
    ["pr", "view-pull-requests"],
  ] as const)(
    "puts Source Control first and omits the current %s destination",
    (activeMode, omittedActionId) => {
      const actions = createSourceControlQuickActions({
        t,
        activeMode,
        onNavigate: vi.fn(),
      });

      expect(actions[0]?.id).toBe("view-source-control");
      expect(actions.map((action) => action.id)).not.toContain(omittedActionId);
      expect(actions).toHaveLength(3);
    }
  );

  it.each(["unstaged", "staged", "stashed"] as const)(
    "treats %s as part of Source Control",
    (activeMode) => {
      const actions = createSourceControlQuickActions({
        t,
        activeMode,
        onNavigate: vi.fn(),
      });

      expect(actions.map((action) => action.id)).not.toContain(
        "view-source-control"
      );
    }
  );

  it.each([
    ["view-source-control", "uncommitted"],
    ["view-issues", "issues"],
    ["view-git-history", "history"],
    ["view-pull-requests", "pr"],
  ] as const)("routes %s to %s", (actionId, destination) => {
    const onNavigate = vi.fn();
    const actions = createSourceControlQuickActions({
      t,
      activeMode:
        actionId === "view-source-control" ? "history" : "uncommitted",
      onNavigate,
    });

    actions.find((action) => action.id === actionId)?.onAction?.();

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith(destination);
  });
});
