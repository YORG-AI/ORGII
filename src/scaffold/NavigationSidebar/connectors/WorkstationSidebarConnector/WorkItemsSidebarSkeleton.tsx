import React from "react";

const ROW_WIDTHS = ["w-4/5", "w-3/5", "w-5/6", "w-2/3", "w-3/4", "w-1/2"];

interface WorkItemsSidebarSkeletonProps {
  loadingLabel: string;
}

/** Loading frame shaped like the Work Items groups and rows it replaces. */
export const WorkItemsSidebarSkeleton: React.FC<WorkItemsSidebarSkeletonProps> =
  React.memo(({ loadingLabel }) => (
    <div
      role="status"
      aria-busy="true"
      aria-label={loadingLabel}
      className="sidebar-list min-h-0 flex-1 overflow-hidden px-3 pt-3"
      data-testid="work-items-sidebar-skeleton"
    >
      <div aria-hidden className="animate-pulse motion-reduce:animate-none">
        <div className="mb-2 h-2.5 w-20 rounded bg-fill-2" />
        <div className="flex flex-col gap-1">
          {ROW_WIDTHS.map((width, index) => (
            <div
              key={`${width}-${index}`}
              className="flex h-8 items-center gap-3 px-2"
            >
              <div className="h-3.5 w-3.5 shrink-0 rounded-full bg-fill-2" />
              <div className="min-w-0 flex-1">
                <div className={`h-3 rounded bg-fill-2 ${width}`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  ));

WorkItemsSidebarSkeleton.displayName = "WorkItemsSidebarSkeleton";
