import { GitPullRequest } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import GitHubDetailHeaderContent from "@src/modules/shared/components/GitHubDetailHeaderContent";
import { getPrStatusVariant } from "@src/shared/pr/prStatus";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

/** Shared status, number, and title content for every PR detail host header. */
export function PrDetailHeaderContent({
  identity,
}: {
  identity: PrIdentity;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const statusVariant = getPrStatusVariant(identity.status);

  return (
    <GitHubDetailHeaderContent
      number={identity.number}
      title={identity.title}
      status={
        <span
          className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium ${statusVariant.badgeClass}`}
        >
          <GitPullRequest size={12} strokeWidth={2} />
          {t(`git.pr.status.${identity.status}`, identity.status)}
        </span>
      }
    />
  );
}
