import type {
  GitHubChecksSummary,
  GitHubIssueUser,
  PullRequestMergeMethod,
} from "@src/api/tauri/github";

import { normalizePrStatus } from "./prStatus";

export interface PullRequestMergeMethodOption {
  method: PullRequestMergeMethod;
  label: string;
}

export interface PullRequestAutoMergeAction {
  kind: "enable" | "disable";
  label:
    | "Enable auto-merge"
    | "Merge when ready"
    | "Disable auto-merge"
    | "Remove from merge queue";
}

export interface PullRequestActionPresentation {
  status: string;
  label: string;
  tooltip: string;
  hasConflicts: boolean;
  directMergeAvailable: boolean;
  methods: PullRequestMergeMethodOption[];
  defaultMethod: PullRequestMergeMethod;
  autoMergeAction: PullRequestAutoMergeAction | null;
}

const MERGE_METHODS: PullRequestMergeMethodOption[] = [
  { method: "merge", label: "Merge" },
  { method: "squash", label: "Squash and merge" },
  { method: "rebase", label: "Rebase and merge" },
];

function readRecord(
  source: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  const value = source?.[key];
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function readBoolean(
  source: Record<string, unknown> | null,
  key: string
): boolean | null {
  const value = source?.[key];
  return typeof value === "boolean" ? value : null;
}

function readString(
  source: Record<string, unknown> | null,
  key: string
): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

export function resolvePullRequestDetailStatus(
  detail: Record<string, unknown> | null,
  fallbackStatus: string
): string {
  if (!detail) return fallbackStatus;
  return normalizePrStatus({
    state: readString(detail, "state") ?? fallbackStatus,
    merged: readBoolean(detail, "merged") === true,
    draft: readBoolean(detail, "draft") === true,
  });
}

export function readRequestedReviewers(
  detail: Record<string, unknown> | null
): GitHubIssueUser[] {
  const value = detail?.requested_reviewers;
  if (!Array.isArray(value)) return [];
  return value.flatMap((reviewer) => {
    if (!reviewer || typeof reviewer !== "object") return [];
    const record = reviewer as Record<string, unknown>;
    const login = typeof record.login === "string" ? record.login : "";
    if (!login) return [];
    return [
      {
        login,
        avatar_url:
          typeof record.avatar_url === "string" ? record.avatar_url : "",
      },
    ];
  });
}

function resolveMergeMethods(
  detail: Record<string, unknown> | null
): PullRequestMergeMethodOption[] {
  const baseRepo = readRecord(readRecord(detail, "base"), "repo");
  const settings: Record<PullRequestMergeMethod, boolean | null> = {
    merge: readBoolean(baseRepo, "allow_merge_commit"),
    squash: readBoolean(baseRepo, "allow_squash_merge"),
    rebase: readBoolean(baseRepo, "allow_rebase_merge"),
  };
  const hasExplicitSettings = Object.values(settings).some(
    (setting) => setting !== null
  );
  if (!hasExplicitSettings) return MERGE_METHODS;
  const enabled = MERGE_METHODS.filter(
    ({ method }) => settings[method] === true
  );
  return enabled.length > 0 ? enabled : MERGE_METHODS;
}

export function presentPullRequestActions({
  detail,
  fallbackStatus,
  checks,
}: {
  detail: Record<string, unknown> | null;
  fallbackStatus: string;
  checks: GitHubChecksSummary | null;
}): PullRequestActionPresentation {
  const status = resolvePullRequestDetailStatus(detail, fallbackStatus);
  const methods = resolveMergeMethods(detail);
  const defaultMethod = methods[0]?.method ?? "merge";
  const autoMergeEnabled = readRecord(detail, "auto_merge") !== null;
  const baseRepo = readRecord(readRecord(detail, "base"), "repo");
  const autoMergeAllowed = readBoolean(baseRepo, "allow_auto_merge") !== false;
  const mergeQueueRequired =
    readBoolean(detail, "merge_queue_required") === true;
  const inMergeQueue = readBoolean(detail, "is_in_merge_queue") === true;
  const reviewDecision = readString(detail, "review_decision")?.toUpperCase();
  const mergeable = readBoolean(detail, "mergeable");
  const restMergeableState = readString(
    detail,
    "mergeable_state"
  )?.toLowerCase();
  const graphqlMergeState = readString(
    detail,
    "merge_state_status"
  )?.toLowerCase();
  // GraphQL mergeStateStatus reports DIRTY reliably while REST mergeability
  // can remain unknown during GitHub's asynchronous mergeability calculation.
  const mergeableState =
    graphqlMergeState && graphqlMergeState !== "unknown"
      ? graphqlMergeState
      : restMergeableState;
  const hasMergeMetadata = mergeable !== null || mergeableState !== undefined;
  const hasConflicts = mergeable === false || mergeableState === "dirty";
  const policyBlocked =
    mergeableState === "blocked" || mergeableState === "behind";
  const unstable = mergeableState === "unstable";
  const openAndReady = status === "open";
  const showConflictAction = openAndReady && !inMergeQueue && hasConflicts;
  const directMergeAvailable =
    openAndReady &&
    !mergeQueueRequired &&
    !hasConflicts &&
    !policyBlocked &&
    (mergeable === true ||
      mergeableState === "clean" ||
      (!hasMergeMetadata && checks?.state === "success"));

  let label =
    methods.find((method) => method.method === defaultMethod)?.label ?? "Merge";
  let tooltip = "Merge this pull request on GitHub";
  if (status === "merged") {
    label = "Merged";
    tooltip = "This pull request is already merged";
  } else if (status === "closed") {
    label = "Closed";
    tooltip = "Reopen this pull request before merging";
  } else if (status === "draft") {
    label = "Draft";
    tooltip = "Mark this pull request ready for review before merging";
  } else if (inMergeQueue) {
    label = "In merge queue";
    tooltip = "GitHub will merge this pull request through the merge queue";
  } else if (showConflictAction) {
    label = "Merge conflicts";
    tooltip = "Resolve merge conflicts before merging";
  } else if (reviewDecision === "REVIEW_REQUIRED") {
    label = "Approval required";
    tooltip = "GitHub requires review approval before merging";
  } else if (reviewDecision === "CHANGES_REQUESTED") {
    label = "Changes requested";
    tooltip = "Requested changes must be resolved before merging";
  } else if (checks?.state === "failure") {
    label = "Checks failed";
    tooltip = "Required checks must pass before merging";
  } else if (checks?.state === "pending") {
    label = "Checks pending";
    tooltip = "Wait for required checks or enable auto-merge";
  } else if (policyBlocked) {
    label = "Merge blocked";
    tooltip = "GitHub reports unmet merge requirements";
  }

  const autoMergeAction =
    status !== "open"
      ? null
      : inMergeQueue
        ? ({ kind: "disable", label: "Remove from merge queue" } as const)
        : autoMergeEnabled
          ? ({ kind: "disable", label: "Disable auto-merge" } as const)
          : mergeQueueRequired
            ? ({ kind: "enable", label: "Merge when ready" } as const)
            : autoMergeAllowed &&
                !directMergeAvailable &&
                !hasConflicts &&
                !unstable
              ? ({
                  kind: "enable",
                  label: "Enable auto-merge",
                } as const)
              : null;

  return {
    status,
    label,
    tooltip,
    hasConflicts: showConflictAction,
    directMergeAvailable,
    methods,
    defaultMethod,
    autoMergeAction,
  };
}
