import React, { memo } from "react";
import { useTranslation } from "react-i18next";

export interface GitHubDetailSkeletonProps {
  kind: "issue" | "pr";
  /** Match hosts that publish the detail title into a shell-owned header. */
  showHeader?: boolean;
}

function SkeletonBar({ className }: { className: string }): React.ReactNode {
  return <div aria-hidden className={`rounded bg-fill-2 ${className}`} />;
}

/**
 * Stable first-paint frame for GitHub issue and pull-request detail tabs.
 * It mirrors the detail hierarchy so lazy chunk loading and the initial data
 * request never fall back to an empty pane or a page spinner.
 */
const GitHubDetailSkeleton: React.FC<GitHubDetailSkeletonProps> = memo(
  ({ kind, showHeader = true }) => {
    const { t } = useTranslation();

    return (
      <div
        role="status"
        aria-busy="true"
        aria-label={t("status.loading")}
        className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-chat-pane"
        data-testid={`github-${kind}-detail-skeleton`}
      >
        {showHeader ? (
          <div className="flex h-10 shrink-0 items-center gap-3 px-4">
            <SkeletonBar className="h-5 w-5 rounded-full" />
            <SkeletonBar className="h-3 w-16" />
            <SkeletonBar className="h-4 w-2/5" />
          </div>
        ) : null}

        {kind === "pr" ? (
          <div className="flex h-10 shrink-0 items-end gap-2 border-b border-border-2 px-3 pb-1">
            <SkeletonBar className="h-7 w-28 rounded-md" />
            <SkeletonBar className="h-7 w-20 rounded-md" />
            <SkeletonBar className="h-7 w-20 rounded-md" />
            <SkeletonBar className="h-7 w-28 rounded-md" />
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="scrollbar-overlay min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-[920px] animate-pulse flex-col gap-3 px-5 py-5 motion-reduce:animate-none">
              {kind === "issue" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <SkeletonBar className="h-7 w-20 rounded-full" />
                  <SkeletonBar className="h-7 w-24 rounded-full" />
                  <SkeletonBar className="h-7 w-32 rounded-full" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-8 gap-y-4 px-1 py-2">
                  <SkeletonBar className="h-4 w-full max-w-64" />
                  <SkeletonBar className="h-4 w-full max-w-40" />
                  <SkeletonBar className="h-4 w-full max-w-52" />
                  <SkeletonBar className="h-4 w-full max-w-32" />
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
        </div>
      </div>
    );
  }
);

GitHubDetailSkeleton.displayName = "GitHubDetailSkeleton";

export default GitHubDetailSkeleton;
