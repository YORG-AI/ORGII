import { describe, expect, it } from "vitest";

import type {
  GitHubChecksSummary,
  GitHubPrReview,
} from "@src/api/tauri/github";
import { SUPPORTED_LANGUAGES } from "@src/i18n";

import {
  type PrMergeStatusRowKind,
  summarizePullRequestMergeStatus,
} from "../prMergeStatus";

function checkRun(
  name: string,
  status: string,
  conclusion: string | null
): GitHubChecksSummary["check_runs"][number] {
  return {
    id: name.length * 31,
    name,
    status,
    conclusion,
    started_at: "2026-09-01T10:00:00Z",
    completed_at: conclusion ? "2026-09-01T10:05:00Z" : null,
    details_url: `https://github.com/org/repo/runs/${name}`,
    output_title: null,
    app_name: "GitHub Actions",
  } as GitHubChecksSummary["check_runs"][number];
}

function summaryOf(
  runs: GitHubChecksSummary["check_runs"],
  state: string
): GitHubChecksSummary {
  return {
    sha: "head",
    check_runs: runs,
    statuses: [],
    state,
  } as GitHubChecksSummary;
}

function review(login: string, state: string): GitHubPrReview {
  return {
    id: login.length,
    user: { login, avatar_url: "" },
    body: "",
    state,
    submitted_at: "2026-09-01T09:00:00Z",
    commit_id: null,
    html_url: "",
  };
}

function kinds(rows: { kind: PrMergeStatusRowKind }[]): PrMergeStatusRowKind[] {
  return rows.map((row) => row.kind);
}

describe("pull request merge status summary", () => {
  it("reports a clean, approved, fully green pull request as mergeable", () => {
    const summary = summarizePullRequestMergeStatus({
      checks: summaryOf([checkRun("build", "completed", "success")], "success"),
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        review_decision: "APPROVED",
      },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(summary.headline).toBe("ableToMerge");
    expect(summary.headlineTone).toBe("success");
    expect(kinds(summary.rows)).toEqual([
      "checksPassed",
      "reviewApproved",
      "noConflicts",
    ]);
    // Only the checks row opens the floating panel.
    expect(summary.rows.filter((row) => row.expandable)).toHaveLength(1);
  });

  it("counts failing checks and blocks the headline on them", () => {
    const summary = summarizePullRequestMergeStatus({
      checks: summaryOf(
        [
          checkRun("build", "completed", "success"),
          checkRun("lint", "completed", "failure"),
          checkRun("e2e", "completed", "timed_out"),
        ],
        "failure"
      ),
      detail: { state: "open", mergeable: true, mergeable_state: "blocked" },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(summary.headline).toBe("blocked");
    expect(summary.headlineTone).toBe("failure");
    expect(summary.rows[0]).toMatchObject({
      kind: "checksFailing",
      tone: "failure",
      count: 2,
    });
    // `blocked` is a policy state, not a conflicted branch.
    expect(kinds(summary.rows)).toContain("noConflicts");
  });

  it("keeps a blocked pull request with running checks amber, not red", () => {
    const summary = summarizePullRequestMergeStatus({
      checks: summaryOf(
        [
          checkRun("build", "completed", "success"),
          checkRun("e2e", "in_progress", null),
        ],
        "pending"
      ),
      detail: { state: "open", mergeable: true, mergeable_state: "blocked" },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(summary.headline).toBe("blocked");
    expect(summary.headlineTone).toBe("pending");
    expect(summary.rows[0]).toMatchObject({
      kind: "checksRunning",
      count: 1,
    });
  });

  it("still offers the merge when only unrequired checks are unsettled", () => {
    // `unstable` is GitHub's "mergeable, but something on the head commit is
    // not green" — the merge button stays live, so the headline must agree
    // with it while the checks row carries the warning.
    const summary = summarizePullRequestMergeStatus({
      checks: summaryOf(
        [
          checkRun("build", "completed", "success"),
          checkRun("e2e", "in_progress", null),
        ],
        "pending"
      ),
      detail: { state: "open", mergeable: true, mergeable_state: "unstable" },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(summary.headline).toBe("ableToMerge");
    expect(kinds(summary.rows)).toEqual(["checksRunning", "noConflicts"]);
  });

  it("reports conflicts from either the REST or the GraphQL merge state", () => {
    const rest = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", mergeable: false },
      fallbackStatus: "open",
      reviews: [],
    });
    const graphql = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", merge_state_status: "DIRTY" },
      fallbackStatus: "open",
      reviews: [],
    });

    // The headline already says "conflicts" here, so the row list should not
    // repeat it with a `hasConflicts` row — see the draft case below, where
    // the headline says "draft" instead and the row is the only place the
    // conflict is reported.
    expect(rest.headline).toBe("conflicts");
    expect(kinds(rest.rows)).toEqual([]);
    expect(graphql.headline).toBe("conflicts");
    expect(kinds(graphql.rows)).toEqual([]);
  });

  it('still reports a hasConflicts row when the headline is not itself "conflicts"', () => {
    const draftWithConflicts = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", draft: true, mergeable: false },
      fallbackStatus: "open",
      reviews: [],
    });

    // Draft PRs never get a "conflicts" headline (draft wins), so the
    // headline alone would not tell the reader conflicts exist — the row
    // must still carry that information.
    expect(draftWithConflicts.headline).toBe("draft");
    expect(kinds(draftWithConflicts.rows)).toEqual(["hasConflicts"]);
  });

  it("falls back to submitted reviews when GitHub reported no review decision", () => {
    const summary = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", mergeable: true, mergeable_state: "clean" },
      fallbackStatus: "open",
      reviews: [
        review("carol", "APPROVED"),
        review("dave", "CHANGES_REQUESTED"),
      ],
    });

    // GitHub still reports the branch as mergeable — an un-enforced change
    // request does not block the button — so the row carries the warning and
    // the headline keeps agreeing with what the merge button will do.
    expect(kinds(summary.rows)).toContain("reviewChangesRequested");
    expect(summary.headline).toBe("ableToMerge");
  });

  it("surfaces the merge queue and auto-merge as their own rows", () => {
    const queued = summarizePullRequestMergeStatus({
      checks: null,
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "clean",
        merge_queue_required: true,
        is_in_merge_queue: true,
      },
      fallbackStatus: "open",
      reviews: [],
    });
    const autoMerge = summarizePullRequestMergeStatus({
      checks: null,
      detail: {
        state: "open",
        mergeable: true,
        mergeable_state: "blocked",
        auto_merge: { merge_method: "squash" },
      },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(queued.headline).toBe("queued");
    expect(kinds(queued.rows)).toContain("inMergeQueue");
    expect(kinds(autoMerge.rows)).toContain("autoMergeEnabled");
  });

  it("drops the mergeability rows once the pull request is settled", () => {
    const merged = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "closed", merged: true },
      fallbackStatus: "open",
      reviews: [],
    });
    const draft = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", draft: true, mergeable: true },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(merged.headline).toBe("merged");
    expect(merged.rows).toEqual([]);
    expect(draft.headline).toBe("draft");
    expect(kinds(draft.rows)).toEqual(["noConflicts"]);
  });

  it("says mergeability is still being computed when GitHub has not answered", () => {
    const summary = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open" },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(summary.headline).toBe("checking");
    expect(kinds(summary.rows)).toEqual(["checkingConflicts"]);
  });

  it("distinguishes a head commit with no checks from one never read", () => {
    const reported = summarizePullRequestMergeStatus({
      checks: summaryOf([], "pending"),
      detail: { state: "open", mergeable: true, mergeable_state: "clean" },
      fallbackStatus: "open",
      reviews: [],
    });
    const unread = summarizePullRequestMergeStatus({
      checks: null,
      detail: { state: "open", mergeable: true, mergeable_state: "clean" },
      fallbackStatus: "open",
      reviews: [],
    });

    expect(kinds(reported.rows)).toContain("checksNone");
    expect(kinds(unread.rows)).not.toContain("checksNone");
  });
});

describe("merge status localization", () => {
  const HEADLINE_KEYS = [
    "ableToMerge",
    "blocked",
    "conflicts",
    "queued",
    "draft",
    "merged",
    "closed",
    "checking",
  ];
  const ROW_KEYS = [
    "checksPassed",
    "checksNone",
    "reviewApproved",
    "reviewRequired",
    "reviewChangesRequested",
    "noConflicts",
    "hasConflicts",
    "outOfDate",
    "checkingConflicts",
    "autoMergeEnabled",
    "inMergeQueue",
    "label",
    "viewChecks",
  ];
  const COUNTED_KEYS = ["checksFailing", "checksRunning", "checksSkipped"];

  // The rail renders these without an English fallback reaching the user, so
  // every shipped language has to resolve them.
  it.each(SUPPORTED_LANGUAGES)(
    "translates the merge status in %s",
    async (language) => {
      const common = (await import(`@src/i18n/locales/${language}/common.json`))
        .default as {
        git: { pr: { mergeStatus: Record<string, string> } };
      };
      const mergeStatus = common.git.pr.mergeStatus;

      for (const key of [...HEADLINE_KEYS, ...ROW_KEYS]) {
        expect(mergeStatus[key], `${language}.${key}`).toBeTruthy();
      }
      for (const key of COUNTED_KEYS) {
        expect(mergeStatus[`${key}_one`], `${language}.${key}_one`).toContain(
          "{{count}}"
        );
        expect(
          mergeStatus[`${key}_other`],
          `${language}.${key}_other`
        ).toContain("{{count}}");
      }
    }
  );
});
