import type { ReactNode } from "react";

export interface DetailHeaderTabsProps {
  title: ReactNode;
  tabs?: ReactNode;
  /** Stack title and tabs below 960px of available detail-panel width. */
  stackTabsBelow?: boolean;
}

/** Compact title + tabs composition for a shared detail header. */
export default function DetailHeaderTabs({
  title,
  tabs,
  stackTabsBelow = false,
}: DetailHeaderTabsProps) {
  const stacksAtNarrowWidth = Boolean(tabs && stackTabsBelow);

  return (
    <div
      className={`flex min-w-0 flex-1 ${
        stacksAtNarrowWidth
          ? "h-auto flex-col items-stretch @[960px]/detailheader:h-10 @[960px]/detailheader:flex-row @[960px]/detailheader:items-center @[960px]/detailheader:gap-2"
          : "h-10 items-center gap-2"
      }`}
    >
      <div
        className={`flex min-w-0 items-center ${
          tabs
            ? stacksAtNarrowWidth
              ? "h-10 w-full flex-none @[960px]/detailheader:h-auto @[960px]/detailheader:w-auto @[960px]/detailheader:max-w-xs @[960px]/detailheader:shrink"
              : "max-w-xs shrink"
            : "flex-1"
        }`}
        data-testid="detail-header-title"
      >
        {title}
      </div>
      {tabs ? (
        <div
          className={
            stacksAtNarrowWidth
              ? "h-10 w-full min-w-0 flex-none @[960px]/detailheader:h-full @[960px]/detailheader:w-auto @[960px]/detailheader:flex-1"
              : "h-full min-w-0 flex-1"
          }
          data-testid="detail-header-tabs"
        >
          {tabs}
        </div>
      ) : null}
    </div>
  );
}
