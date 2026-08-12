import { describe, expect, it } from "vitest";

import {
  presentPullRequestActions,
  readRequestedReviewers,
  resolvePullRequestDetailStatus,
} from "./prLevelActions";

describe("PR-level action presentation", () => {
  it("uses concise merge-method labels", () => {
    const presentation = presentPullRequestActions({
      detail: { state: "open" },
      fallbackStatus: "open",
      checks: null,
    });

    expect(presentation.methods.map(({ label }) => label)).toEqual([
      "Merge",
      "Squash and merge",
      "Rebase and merge",
    ]);
  });

  it("uses repository merge settings and allows a clean PR to merge", () => {
    const presentation = presentPullRequestActions({
      detail: {
        state: "open",
        merged: false,
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        base: {
          repo: {
            allow_merge_commit: false,
            allow_squash_merge: true,
            allow_rebase_merge: true,
            allow_auto_merge: true,
          },
        },
      },
      fallbackStatus: "open",
      checks: { sha: "head", check_runs: [], statuses: [], state: "success" },
    });

    expect(presentation.directMergeAvailable).toBe(true);
    expect(presentation.defaultMethod).toBe("squash");
    expect(presentation.methods.map(({ method }) => method)).toEqual([
      "squash",
      "rebase",
    ]);
    expect(presentation.autoMergeAction).toBeNull();
  });

  it("offers merge-when-ready while checks or policy requirements block direct merge", () => {
    const presentation = presentPullRequestActions({
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "blocked",
      },
      fallbackStatus: "open",
      checks: { sha: "head", check_runs: [], statuses: [], state: "pending" },
    });

    expect(presentation.directMergeAvailable).toBe(false);
    expect(presentation.label).toBe("Checks pending");
    expect(presentation.autoMergeAction).toEqual({
      kind: "enable",
      label: "Enable auto-merge",
    });
  });

  it("disables direct merge for conflicts and exposes an existing auto-merge request", () => {
    const presentation = presentPullRequestActions({
      detail: {
        state: "open",
        mergeable: false,
        mergeable_state: "dirty",
        auto_merge: { enabled_by: { login: "reviewer" } },
      },
      fallbackStatus: "open",
      checks: null,
    });

    expect(presentation.directMergeAvailable).toBe(false);
    expect(presentation.hasConflicts).toBe(true);
    expect(presentation.label).toBe("Merge conflicts");
    expect(presentation.autoMergeAction).toEqual({
      kind: "disable",
      label: "Disable auto-merge",
    });
  });

  it("prefers GraphQL conflict state while REST mergeability is unsettled", () => {
    const presentation = presentPullRequestActions({
      detail: {
        state: "open",
        mergeable_state: "unknown",
        merge_state_status: "DIRTY",
      },
      fallbackStatus: "open",
      checks: { sha: "head", check_runs: [], statuses: [], state: "success" },
    });

    expect(presentation.hasConflicts).toBe(true);
    expect(presentation.directMergeAvailable).toBe(false);
    expect(presentation.label).toBe("Merge conflicts");
    expect(presentation.autoMergeAction).toBeNull();
  });

  it("trusts GitHub mergeability when optional checks are still running", () => {
    const presentation = presentPullRequestActions({
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        base: { repo: { allow_auto_merge: true } },
      },
      fallbackStatus: "open",
      checks: { sha: "head", check_runs: [], statuses: [], state: "pending" },
    });

    expect(presentation.directMergeAvailable).toBe(true);
    expect(presentation.label).toBe("Checks pending");
    expect(presentation.autoMergeAction).toBeNull();
  });

  it("does not offer auto-merge for conflicts or unstable status", () => {
    const conflicting = presentPullRequestActions({
      detail: { state: "open", mergeable: false, mergeable_state: "dirty" },
      fallbackStatus: "open",
      checks: null,
    });
    const unstable = presentPullRequestActions({
      detail: { state: "open", mergeable_state: "unstable" },
      fallbackStatus: "open",
      checks: null,
    });

    expect(conflicting.autoMergeAction).toBeNull();
    expect(unstable.autoMergeAction).toBeNull();
  });

  it("routes merge-queue branches through merge when ready", () => {
    const waiting = presentPullRequestActions({
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        merge_queue_required: true,
      },
      fallbackStatus: "open",
      checks: { sha: "head", check_runs: [], statuses: [], state: "success" },
    });
    const queued = presentPullRequestActions({
      detail: {
        state: "open",
        merge_queue_required: true,
        is_in_merge_queue: true,
      },
      fallbackStatus: "open",
      checks: null,
    });

    expect(waiting.directMergeAvailable).toBe(false);
    expect(waiting.autoMergeAction).toEqual({
      kind: "enable",
      label: "Merge when ready",
    });
    expect(queued.autoMergeAction).toEqual({
      kind: "disable",
      label: "Remove from merge queue",
    });
  });

  it("derives merged and draft status from authoritative PR detail", () => {
    expect(
      resolvePullRequestDetailStatus(
        { state: "closed", merged: true, draft: false },
        "open"
      )
    ).toBe("merged");
    expect(
      resolvePullRequestDetailStatus(
        { state: "open", merged: false, draft: true },
        "open"
      )
    ).toBe("draft");
  });

  it("reads only valid requested reviewer users", () => {
    expect(
      readRequestedReviewers({
        requested_reviewers: [
          { login: "reviewer", avatar_url: "https://avatars/reviewer" },
          { avatar_url: "https://avatars/missing-login" },
          null,
        ],
      })
    ).toEqual([
      {
        login: "reviewer",
        avatar_url: "https://avatars/reviewer",
      },
    ]);
  });
});
