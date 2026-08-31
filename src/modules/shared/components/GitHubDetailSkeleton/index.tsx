import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import WorkstationTrailSurface, {
  WORKSTATION_TRAIL_RAIL_PADDING_CLASS,
  WORKSTATION_TRAIL_WIDTH,
  WorkstationTrailBody,
  WorkstationTrailHeader,
  WorkstationTrailSection,
} from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";
import type { PrDetailTab } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import GitHubPrDetailTabs from "../GitHubPrDetailTabs";

export interface GitHubDetailSkeletonProps {
  kind: "issue" | "pr";
  /** Match hosts that publish the detail title into a shell-owned header. */
  showHeader?: boolean;
  /** Show PR navigation when the tabs are owned by this surface. */
  showTabs?: boolean;
  /** Live navigation supplied by a host whose code is already loaded. */
  tabs?: React.ReactNode;
  activeTab?: PrDetailTab;
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
          <div className="flex h-10 shrink-0 items-center gap-3 px-4">
            <SkeletonBar className="h-5 w-5 rounded-full" />
            <SkeletonBar className="h-3 w-16" />
            <SkeletonBar className="h-4 w-2/5" />
          </div>
        ) : null}

        {kind === "pr" && showTabs
          ? (tabs ?? <GitHubPrDetailTabs activeTab={activeTab} />)
          : null}

        <div
          aria-busy="true"
          aria-label={t("status.loading")}
          className="flex min-h-0 flex-1 overflow-hidden"
        >
          <div
            role={kind === "pr" ? "tabpanel" : undefined}
            id={kind === "pr" ? `pr-detail-tabpanel-${activeTab}` : undefined}
            aria-labelledby={
              kind === "pr" ? `pr-detail-tab-${activeTab}` : undefined
            }
            className="scrollbar-overlay min-h-0 min-w-0 flex-1 overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3 px-5 py-5">
              {kind === "issue" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <SkeletonBar className="h-7 w-20 rounded-full" />
                  <SkeletonBar className="h-7 w-24 rounded-full" />
                  <SkeletonBar className="h-7 w-32 rounded-full" />
                </div>
              ) : (
                <div className="flex flex-col gap-3 px-1 py-2">
                  {title ? (
                    <h2 className="min-w-0 select-text text-[20px] font-semibold leading-7 text-text-1">
                      {title}{" "}
                      {number !== undefined ? (
                        <span className="whitespace-nowrap font-normal text-text-3">
                          #{number}
                        </span>
                      ) : null}
                    </h2>
                  ) : (
                    <SkeletonBar className="h-6 w-full max-w-96" />
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <SkeletonBar className="h-6 w-20 rounded-full" />
                    <SkeletonBar className="h-4 w-full max-w-72" />
                  </div>
                </div>
              )}

              <section className="overflow-hidden rounded-xl border border-border-1 bg-primary-container">
                <div className="flex h-10 items-center gap-2 border-b border-border-1 px-3">
                  <SkeletonBar className="h-4 w-4 rounded-full" />
                  <SkeletonBar className="h-3 w-28" />
                </div>
                <div className="space-y-3 px-4 py-4">
                  <SkeletonBar className="h-3 w-full" />
                  <SkeletonBar className="h-3 w-11/12" />
                  <SkeletonBar className="h-3 w-4/5" />
                  <SkeletonBar className="h-3 w-2/3" />
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-border-1 bg-primary-container">
                <div className="flex h-10 items-center gap-2 border-b border-border-1 px-3">
                  <SkeletonBar className="h-4 w-4 rounded-full" />
                  <SkeletonBar className="h-3 w-24" />
                </div>
                <div className="space-y-4 px-4 py-4">
                  <div className="flex gap-3">
                    <SkeletonBar className="h-8 w-8 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <SkeletonBar className="h-3 w-32" />
                      <SkeletonBar className="h-3 w-full" />
                      <SkeletonBar className="h-3 w-3/4" />
                    </div>
                  </div>
                  <div className="flex gap-3">
                    <SkeletonBar className="h-8 w-8 shrink-0 rounded-full" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <SkeletonBar className="h-3 w-24" />
                      <SkeletonBar className="h-3 w-5/6" />
                    </div>
                  </div>
                </div>
              </section>
            </div>
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
                    <div className="px-2 py-1">
                      <SkeletonBar className="h-5 w-24" />
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
