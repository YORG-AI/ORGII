import React from "react";
import { useTranslation } from "react-i18next";

import type { OpenPRItem } from "@src/api/tauri/github";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
} from "@src/icons";
import {
  getPrStatusIconName,
  getPrStatusLabelKey,
} from "@src/shared/pr/prStatus";

import "./BranchPullRequestIcon.scss";

const GLYPHS = {
  "pull-request": GitPullRequestIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merge: GitMergeIcon,
};

function createStatusIcon(status: string) {
  // Created once per state, never inside a row render.
  return function PullRequestStatusIcon({
    size,
    strokeWidth,
  }: Record<string, unknown>) {
    const { t } = useTranslation("common");
    const name = getPrStatusIconName(status);
    return (
      <HugeiconsIcon
        icon={GLYPHS[name]}
        size={typeof size === "number" ? size : 16}
        strokeWidth={typeof strokeWidth === "number" ? strokeWidth : 2}
        className="branch-picker-pr-icon shrink-0"
        data-pr-status={status}
        data-icon={`pr-${name}`}
        role="img"
        aria-label={t(getPrStatusLabelKey(status))}
      />
    );
  };
}

const STATUS_ICONS: Record<
  string,
  React.ComponentType<Record<string, unknown>>
> = {
  open: createStatusIcon("open"),
  draft: createStatusIcon("draft"),
  closed: createStatusIcon("closed"),
  merged: createStatusIcon("merged"),
  unknown: createStatusIcon("unknown"),
};

export function getBranchPullRequestIcon(
  pr: Pick<OpenPRItem, "state" | "draft">
) {
  const state = pr.state?.toLowerCase();
  // GitHub retains the draft flag on closed PRs; terminal state takes priority.
  const status = state === "open" && pr.draft ? "draft" : state;
  return STATUS_ICONS[status] ?? STATUS_ICONS.unknown;
}
