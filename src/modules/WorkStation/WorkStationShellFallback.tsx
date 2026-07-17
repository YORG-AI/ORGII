import React, { memo } from "react";

interface WorkStationShellFallbackProps {}

const tabWidths = [112, 88, 136, 104];
const sideRows = [80, 124, 96, 144, 108, 132];
const dockItems = ["code", "browser", "data", "project"];

const skeletonClass = "animate-pulse rounded bg-fill-3/70";

function SkeletonBlock({
  className,
  style,
}: {
  className: string;
  style?: React.CSSProperties;
}) {
  return <div className={`${skeletonClass} ${className}`} style={style} />;
}

export const WorkStationShellFallback: React.FC<WorkStationShellFallbackProps> =
  memo(() => {
    return (
      <div
        className="group relative flex h-full w-full min-w-0 flex-col overflow-hidden bg-workstation-bg"
        aria-busy="true"
        aria-label="Loading WorkStation"
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-1 bg-workstation-bg px-2">
            <SkeletonBlock className="h-6 w-8 rounded-md" />
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
              {tabWidths.map((width, index) => (
                <SkeletonBlock
                  key={`${width}-${index}`}
                  className="h-7 shrink-0 rounded-md"
                  style={{ width }}
                />
              ))}
            </div>
            <SkeletonBlock className="h-5 w-5 rounded" />
            <SkeletonBlock className="h-5 w-5 rounded" />
          </div>

          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-2 pl-1.5 pr-2">
            <SkeletonBlock className="h-6 w-20 rounded-md" />
            <div className="h-5 w-px bg-border-2" />
            <SkeletonBlock className="h-4 w-48 max-w-[35%]" />
            <SkeletonBlock className="h-4 w-28" />
            <div className="ml-auto flex items-center gap-1">
              <SkeletonBlock className="h-5 w-5 rounded" />
              <SkeletonBlock className="h-5 w-5 rounded" />
              <SkeletonBlock className="h-5 w-16 rounded" />
            </div>
          </div>

          <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-pane-raised">
            <aside className="hidden w-[260px] shrink-0 flex-col border-r border-border-2 bg-workstation-bg/80 md:flex">
              <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border-2 px-3">
                <SkeletonBlock className="h-4 w-24" />
                <div className="ml-auto flex gap-1">
                  <SkeletonBlock className="h-5 w-5 rounded" />
                  <SkeletonBlock className="h-5 w-5 rounded" />
                </div>
              </div>
              <div className="flex flex-col gap-2 p-3">
                {sideRows.map((width, index) => (
                  <SkeletonBlock
                    key={`${width}-${index}`}
                    className="h-5 rounded"
                    style={{ width }}
                  />
                ))}
              </div>
            </aside>

            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border-2 bg-workstation-bg/70 px-3">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-4 w-24" />
                <div className="ml-auto flex gap-1">
                  <SkeletonBlock className="h-5 w-5 rounded" />
                  <SkeletonBlock className="h-5 w-5 rounded" />
                </div>
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-border-2 lg:grid-cols-[minmax(0,1fr)_320px]">
                <div className="flex min-h-0 flex-col gap-3 bg-pane-raised p-4">
                  <SkeletonBlock className="h-4 w-3/5" />
                  <SkeletonBlock className="h-4 w-4/5" />
                  <SkeletonBlock className="h-4 w-2/3" />
                  <SkeletonBlock className="h-28 w-full rounded-lg" />
                  <SkeletonBlock className="h-4 w-1/2" />
                  <SkeletonBlock className="h-4 w-3/4" />
                </div>
                <div className="hidden min-h-0 flex-col gap-3 bg-workstation-bg/80 p-3 lg:flex">
                  <SkeletonBlock className="h-4 w-32" />
                  <SkeletonBlock className="h-20 w-full rounded-lg" />
                  <SkeletonBlock className="h-20 w-full rounded-lg" />
                  <SkeletonBlock className="h-4 w-44" />
                </div>
              </div>
            </main>
          </div>
        </div>

        <div className="flex h-7 shrink-0 items-center gap-3 border-t border-border-2 px-3 text-[11px]">
          <SkeletonBlock className="h-3 w-20" />
          <SkeletonBlock className="h-3 w-28" />
          <div className="ml-auto flex gap-3">
            <SkeletonBlock className="h-3 w-16" />
            <SkeletonBlock className="h-3 w-12" />
          </div>
        </div>

        <div className="flex w-full shrink-0 flex-col items-center border-t border-border-2 px-3 py-0.5">
          <div className="flex h-12 w-full items-center justify-center">
            <div className="flex items-center gap-2 rounded-2xl border border-border-2 bg-bg-2/80 px-3 py-1.5 shadow-sm">
              {dockItems.map((item) => (
                <SkeletonBlock key={item} className="h-8 w-8 rounded-xl" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  });

WorkStationShellFallback.displayName = "WorkStationShellFallback";

export default WorkStationShellFallback;
