import React from "react";
import { useTranslation } from "react-i18next";

import type { PullRequestCiStatus } from "@src/api/tauri/github";
import PrCiStatusIndicator from "@src/components/PrCiStatusIndicator";

import "./BranchPullRequestIcon.scss";

const LABEL_KEYS: Record<PullRequestCiStatus, string> = {
  success: "git.pr.checks.passedShort",
  failure: "git.pr.checks.failedShort",
  pending: "git.pr.checks.runningShort",
  none: "git.pr.checks.noneShort",
  unavailable: "git.pr.checks.unavailableShort",
};

/** Displays the list response only; rows never fetch their own checks. */
export function BranchPullRequestChecks({
  status = "unavailable",
}: {
  status: PullRequestCiStatus;
}) {
  const { t } = useTranslation("common");
  return (
    <PrCiStatusIndicator
      appearance="simple"
      status={status}
      label={t(LABEL_KEYS[status])}
      showLabel={false}
      size={16}
      className={`branch-picker-ci-status branch-picker-ci-status-${status}`}
      dataTestId="branch-picker-checks"
    />
  );
}
