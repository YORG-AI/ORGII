import React, { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { TimelineLoadingSkeleton } from "@src/modules/shared/components/ActivityTimeline";

import type { GitHubLinkedReferencesProps } from ".";

const GitHubLinkedReferences = React.lazy(() => import("."));

/** Webpack lazy boundary shared by every Conversation / Linked detail surface. */
export default function LazyGitHubLinkedReferences(
  props: GitHubLinkedReferencesProps
): React.ReactNode {
  const { t } = useTranslation("common");

  return (
    <Suspense
      fallback={
        <div className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div
            className={`${DETAIL_PANEL_TOKENS.headerWidth} ${DETAIL_PANEL_TOKENS.threadContentPadding} w-full`}
          >
            <TimelineLoadingSkeleton
              label={t("git.issues.linkedLoading", "Loading linked items")}
            />
          </div>
        </div>
      }
    >
      <GitHubLinkedReferences {...props} />
    </Suspense>
  );
}
