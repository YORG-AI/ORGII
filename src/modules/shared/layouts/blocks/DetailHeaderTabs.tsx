import type { ReactNode } from "react";

export interface DetailHeaderTabsProps {
  title: ReactNode;
  tabs?: ReactNode;
}

/** Compact `title | tabs` composition for a shared 40px detail header. */
export default function DetailHeaderTabs({
  title,
  tabs,
}: DetailHeaderTabsProps) {
  return (
    <div className="flex h-10 min-w-0 flex-1 items-center">
      <div
        className={`flex min-w-0 items-center ${tabs ? "max-w-xs shrink" : "flex-1"}`}
        data-testid="detail-header-title"
      >
        {title}
      </div>
      {tabs ? (
        <>
          <span
            className="mx-2 h-4 w-px shrink-0 bg-border-2"
            role="separator"
            aria-hidden
            data-testid="detail-header-tabs-separator"
          />
          <div
            className="h-full min-w-0 flex-1"
            data-testid="detail-header-tabs"
          >
            {tabs}
          </div>
        </>
      ) : null}
    </div>
  );
}
