import React from "react";

import AnyIcon from "@src/components/AnyIcon";
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "@src/icons";
import GitHubDetailHeaderContent from "@src/modules/shared/components/GitHubDetailHeaderContent";
import {
  getPrStatusIconName,
  getPrStatusVariant,
} from "@src/shared/pr/prStatus";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

/** Semantic pull-request icon shared by compact and expanded status surfaces. */
export function PrStatusIcon({ status }: { status: string }): React.ReactNode {
  const iconName = getPrStatusIconName(status);
  const [StatusIcon, dataIcon] =
    iconName === "draft"
      ? [GitPullRequestDraftIcon, "git-pull-request-draft"]
      : iconName === "merge"
        ? [GitMergeIcon, "git-merge"]
        : iconName === "closed"
          ? [GitPullRequestClosedIcon, "git-pull-request-closed"]
          : [GitPullRequestIcon, "git-pull-request"];

  return (
    <AnyIcon
      icon={StatusIcon}
      data-icon={dataIcon}
      size={14}
      strokeWidth={1.75}
      aria-hidden
    />
  );
}

/** Shared status, number, and title content for every PR detail host header. */
export function PrDetailHeaderContent({
  identity,
}: {
  identity: PrIdentity;
}): React.ReactNode {
  const statusVariant = getPrStatusVariant(identity.status);

  return (
    <GitHubDetailHeaderContent
      number={identity.number}
      title={identity.title}
      status={
        <span
          className={`inline-flex h-5 shrink-0 items-center ${statusVariant.textClass}`}
          data-testid="pr-detail-status"
          aria-label={identity.status}
          title={identity.status}
        >
          <PrStatusIcon status={identity.status} />
        </span>
      }
    />
  );
}
