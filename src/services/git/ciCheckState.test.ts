import { describe, expect, it } from "vitest";

import type {
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubStatusContext,
} from "@src/api/tauri/github";

import {
  areChecksSettled,
  checkRunState,
  countCheckStates,
  flattenChecks,
  statusContextState,
} from "./ciCheckState";

function run(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 1,
    name: "build",
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/acme/repo/runs/1",
    started_at: null,
    completed_at: null,
    output_title: null,
    app_name: null,
    ...overrides,
  };
}

function status(
  overrides: Partial<GitHubStatusContext> = {}
): GitHubStatusContext {
  return {
    context: "ci/legacy",
    state: "success",
    description: null,
    target_url: null,
    avatar_url: null,
    ...overrides,
  };
}

function summary(
  check_runs: GitHubCheckRun[],
  statuses: GitHubStatusContext[] = []
): GitHubChecksSummary {
  return { sha: "abc123", check_runs, statuses, state: "pending" };
}

describe("ciCheckState", () => {
  it("treats an in-flight run and a completed-without-conclusion run as pending", () => {
    expect(checkRunState(run({ status: "queued", conclusion: null }))).toBe(
      "pending"
    );
    expect(
      checkRunState(run({ status: "in_progress", conclusion: null }))
    ).toBe("pending");
    expect(checkRunState(run({ conclusion: null }))).toBe("pending");
  });

  it("maps every failing conclusion to failure and non-verdicts to neutral", () => {
    for (const conclusion of [
      "failure",
      "timed_out",
      "action_required",
      "cancelled",
      "startup_failure",
    ]) {
      expect(checkRunState(run({ conclusion }))).toBe("failure");
    }
    for (const conclusion of ["neutral", "skipped", "stale"]) {
      expect(checkRunState(run({ conclusion }))).toBe("neutral");
    }
    expect(statusContextState(status({ state: "error" }))).toBe("failure");
    expect(statusContextState(status({ state: "pending" }))).toBe("pending");
  });

  it("flattens runs before statuses and keeps the app name unmerged", () => {
    const items = flattenChecks(
      summary(
        [run({ id: 7, name: "test", app_name: "GitHub Actions" })],
        [status({ context: "ci/legacy" })]
      )
    );

    expect(items.map((item) => item.key)).toEqual([
      "run-7",
      "status-ci/legacy",
    ]);
    // The reporting app stays a separate field so the label can drop it.
    expect(items[0].name).toBe("test");
    expect(items[0].appName).toBe("GitHub Actions");
    expect(items[1].name).toBe("ci/legacy");
    expect(items[1].appName).toBeNull();
  });

  it("counts states across runs and statuses", () => {
    const counts = countCheckStates(
      flattenChecks(
        summary(
          [
            run({ id: 1 }),
            run({ id: 2, status: "in_progress", conclusion: null }),
            run({ id: 3, conclusion: "failure" }),
            run({ id: 4, conclusion: "skipped" }),
          ],
          [status({ state: "pending" })]
        )
      )
    );

    expect(counts).toEqual({
      total: 5,
      success: 1,
      failure: 1,
      pending: 2,
      neutral: 1,
    });
  });

  it("settles only once nothing is still pending", () => {
    expect(areChecksSettled(null)).toBe(false);
    // Empty is not settled — CI may not have registered its runs yet.
    expect(areChecksSettled(summary([]))).toBe(false);
    expect(
      areChecksSettled(
        summary([run({ status: "in_progress", conclusion: null })])
      )
    ).toBe(false);
    // A decided failure alongside a still-running job is not settled: the rows
    // keep moving even though the roll-up verdict cannot change.
    expect(
      areChecksSettled(
        summary([
          run({ id: 1, conclusion: "failure" }),
          run({ id: 2, status: "in_progress", conclusion: null }),
        ])
      )
    ).toBe(false);
    expect(
      areChecksSettled(summary([run({ conclusion: "failure" })], [status()]))
    ).toBe(true);
    expect(areChecksSettled(summary([], [status({ state: "pending" })]))).toBe(
      false
    );
  });
});
