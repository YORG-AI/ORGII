/**
 * UnifiedTabContent — single dispatcher component for all WorkStation
 * tab content. Looks up `tab.type` in `REGISTRY` and renders the
 * matching lazy renderer wrapper inside a `Suspense` boundary (so
 * switching between two already-loaded tabs of the same chunk does
 * not re-suspend).
 *
 * CodeEditor mounts this dispatcher for registry-owned tabs that do not
 * need host-coupled editor props; other hosts can mount it directly as
 * their adapters are retired.
 */
import React, { Suspense, memo } from "react";

import GitHubDetailSkeleton from "@src/modules/shared/components/GitHubDetailSkeleton";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import { TabLoadingPlaceholder } from "./TabLoadingPlaceholder";
import { UnknownTabPlaceholder } from "./UnknownTabPlaceholder";
import { REGISTRY } from "./registry";

export interface UnifiedTabContentDispatcherProps {
  tab: WorkStationTab;
  paneId: string;
  isActive: boolean;
}

export const UnifiedTabContent: React.FC<UnifiedTabContentDispatcherProps> =
  memo(({ tab, paneId, isActive }) => {
    const entry = REGISTRY[tab.type];
    if (!entry) {
      return <UnknownTabPlaceholder type={tab.type} />;
    }
    const { Component } = entry;
    const fallback =
      tab.type === "github-issue-detail" ? (
        <GitHubDetailSkeleton
          kind="issue"
          showHeader={false}
          showTabs={false}
          title={tab.data.issueTitle as string}
          number={tab.data.issueNumber as number}
        />
      ) : tab.type === "github-pr-detail" ? (
        <GitHubDetailSkeleton kind="pr" showHeader={false} showTabs={false} />
      ) : (
        <TabLoadingPlaceholder />
      );
    return (
      <Suspense fallback={fallback}>
        <Component tab={tab} paneId={paneId} isActive={isActive} />
      </Suspense>
    );
  });

UnifiedTabContent.displayName = "UnifiedTabContent";

export default UnifiedTabContent;
