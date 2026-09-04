import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import {
  TimelineCard,
  TimelineLoadingSkeleton,
} from "@src/modules/shared/components/ActivityTimeline";
import { DETAIL_FLOW_HEADER_TOKENS } from "@src/modules/shared/components/DetailFlowHeader";
import WorkstationTrailSurface, {
  WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_WIDTH,
  WorkstationTrailBody,
  WorkstationTrailHeader,
  WorkstationTrailSection,
} from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";
import type { PrDetailTab } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import GitHubPrDetailTabs from "../GitHubPrDetailTabs";
import ThreadDetailTabs, { type ThreadDetailTab } from "../ThreadDetailTabs";

interface GitHubDetailSkeletonProps {
  kind: "issue" | "pr";
  /** Match hosts that publish the detail title into a shell-owned header. */
  showHeader?: boolean;
  /** Show detail navigation when the tabs are owned by this surface. */
  showTabs?: boolean;
  /** Live navigation supplied by a host whose code is already loaded. */
  tabs?: React.ReactNode;
  activeTab?: PrDetailTab | ThreadDetailTab;
  /** Hide the flow title when the owning header already contains the title. */
  showFlowHeader?: boolean;
  /** Render the known selection title without waiting for the detail request. */
  title?: string;
  number?: number;
}

function SkeletonBar({ className }: { className: string }): React.ReactNode {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded bg-fill-2 motion-reduce:animate-none ${className}`}
    />
  );
}

// The detail metadata pills and workstation-trail rows are both 26px tall.
// Keep their placeholders at that height so loading does not make either
// Work Item or PR detail surface look vertically compressed.
const SKELETON_CONTROL_HEIGHT = "h-[26px]";

function SkeletonFlowHeader({
  title,
  number,
}: Pick<GitHubDetailSkeletonProps, "title" | "number">): React.ReactNode {
  return (
    <div className={DETAIL_FLOW_HEADER_TOKENS.container}>
      {title ? (
        <h2 className={DETAIL_FLOW_HEADER_TOKENS.title}>
          {title}{" "}
          {number !== undefined ? (
            <span className="font-normal whitespace-nowrap text-text-3">
              #{number}
            </span>
          ) : null}
        </h2>
      ) : (
        <SkeletonBar className="h-7 w-full max-w-96" />
      )}
      <div className={DETAIL_FLOW_HEADER_TOKENS.metadataRow}>
        <SkeletonBar
          className={`${SKELETON_CONTROL_HEIGHT} w-16 rounded-full`}
        />
        <SkeletonBar className="h-4 w-full max-w-72" />
      </div>
    </div>
  );
}

function SkeletonDescriptionCard(): React.ReactNode {
  return (
    <TimelineCard
      header={
        <span className="flex min-w-0 items-center gap-2">
          <SkeletonBar className="size-5 rounded-full" />
          <SkeletonBar className="h-3 w-28" />
          <SkeletonBar className="h-3 w-16" />
        </span>
      }
    >
      <div className="space-y-2.5">
        <SkeletonBar className="block h-3 w-full" />
        <SkeletonBar className="block h-3 w-11/12" />
        <SkeletonBar className="block h-3 w-4/5" />
        <SkeletonBar className="block h-3 w-2/3" />
      </div>
    </TimelineCard>
  );
}

function FlowSkeletonContent({
  title,
  number,
  loadingLabel,
  showFlowHeader,
}: Pick<GitHubDetailSkeletonProps, "title" | "number"> & {
  loadingLabel: string;
  showFlowHeader: boolean;
}): React.ReactNode {
  return (
    <>
      {showFlowHeader ? (
        <div
          className={`${DETAIL_PANEL_TOKENS.headerWidth} ${DETAIL_PANEL_TOKENS.flowHeaderPadding}`}
        >
          <SkeletonFlowHeader title={title} number={number} />
        </div>
      ) : null}
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} ${DETAIL_PANEL_TOKENS.threadContentPadding} flex flex-col gap-3`}
      >
        <SkeletonDescriptionCard />
        <TimelineLoadingSkeleton label={loadingLabel} />
      </div>
    </>
  );
}

/**
 * Stable first-paint frame for GitHub issue and pull-request detail tabs.
 * It mirrors the detail hierarchy so lazy chunk loading and the initial data
 * request never fall back to an empty pane or a page spinner.
 */
const GitHubDetailSkeleton: React.FC<GitHubDetailSkeletonProps> = memo(
  ({
    kind,
    showHeader = true,
    showTabs = true,
    tabs,
    activeTab = "conversation",
    showFlowHeader = true,
    title,
    number,
  }) => {
    const { t } = useTranslation("common");
    const sidebarSections =
      kind === "pr"
        ? [
            t("git.pr.sidebar.reviewers", "Reviewers"),
            t("git.pr.sidebar.assignees", "Assignees"),
            t("git.pr.sidebar.labels", "Labels"),
            t("git.pr.sidebar.actions", "Actions"),
          ]
        : [
            t("projects:workItems.contextMenu.status", "Status"),
            t("projects:workItems.properties.labels", "Labels"),
            t("projects:workItems.properties.assignment", "Assignment"),
          ];

    return (
      <div
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-chat-pane"
        data-testid={`github-${kind}-detail-skeleton`}
      >
        <span role="status" className="sr-only">
          {t("status.loading")}
        </span>
        {showHeader ? (
          <div
            className={`flex ${DETAIL_PANEL_TOKENS.headerHeight} shrink-0 items-center gap-3 px-4`}
            data-testid={`github-${kind}-detail-skeleton-header`}
          >
            <SkeletonBar className="h-5 w-5 rounded-full" />
            <SkeletonBar className="h-3 w-16" />
            <SkeletonBar className="h-4 w-2/5" />
          </div>
        ) : null}

        {showTabs
          ? (tabs ??
            (kind === "pr" ? (
              <GitHubPrDetailTabs activeTab={activeTab as PrDetailTab} />
            ) : (
              <ThreadDetailTabs
                activeTab={activeTab as ThreadDetailTab}
                conversationCountLoading
                linkedCountLoading
                idPrefix="issue-detail"
              />
            )))
          : null}

        <div
          aria-busy="true"
          aria-label={t("status.loading")}
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          <div
            role="tabpanel"
            id={`${kind === "pr" ? "pr-detail" : "issue-detail"}-tabpanel-${activeTab}`}
            aria-labelledby={`${kind === "pr" ? "pr-detail" : "issue-detail"}-tab-${activeTab}`}
            className="scrollbar-hide min-h-0 min-w-0 flex-1 overflow-y-auto"
          >
            <FlowSkeletonContent
              title={title}
              number={number}
              loadingLabel={
                kind === "pr"
                  ? t("git.pr.loadingConversation", "Loading…")
                  : t("git.issues.loadingTimeline", "Loading activity…")
              }
              showFlowHeader={showFlowHeader}
            />
          </div>
          <div
            className={`box-border flex h-full shrink-0 flex-col ${WORKSTATION_TRAIL_RAIL_PADDING_CLASS}`}
            style={{ width: WORKSTATION_TRAIL_WIDTH.expandedPx }}
            data-testid={`github-${kind}-detail-skeleton-sidebar`}
          >
            <WorkstationTrailSurface className="flex self-start">
              {kind === "issue" ? (
                <WorkstationTrailHeader
                  title={t(
                    "projects:workItems.properties.title",
                    "Work Item Properties"
                  )}
                />
              ) : null}
              <WorkstationTrailBody
                className={`${WORKSTATION_TRAIL_CONTENT.sectionList} py-1`}
              >
                {sidebarSections.map((label) => (
                  <WorkstationTrailSection key={label} title={label}>
                    <div className="px-2">
                      <SkeletonBar
                        className={`${SKELETON_CONTROL_HEIGHT} w-24 rounded-lg`}
                      />
                    </div>
                  </WorkstationTrailSection>
                ))}
              </WorkstationTrailBody>
            </WorkstationTrailSurface>
          </div>
        </div>
      </div>
    );
  }
);

GitHubDetailSkeleton.displayName = "GitHubDetailSkeleton";

export default GitHubDetailSkeleton;
