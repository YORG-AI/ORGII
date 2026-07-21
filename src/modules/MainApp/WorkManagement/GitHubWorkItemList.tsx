import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { ReactNode } from "react";

import Button from "@src/components/Button";
import { PAGE_ICON_BUTTON } from "@src/components/SettingsTable/SettingsTablePagination";
import TabPill, { type TabPillItem } from "@src/components/TabPill";

export function GitHubWorkItemToolbarActions({
  refreshLabel,
  refreshing,
  createAction,
  onRefresh,
}: {
  refreshLabel: string;
  refreshing: boolean;
  createAction?: {
    label: string;
    disabled: boolean;
    onClick: () => void;
  };
  onRefresh: () => void;
}): ReactNode {
  return (
    <>
      {createAction ? (
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          icon={<Plus size={13} />}
          iconOnly
          className="h-7 w-7"
          aria-label={createAction.label}
          onClick={createAction.onClick}
          disabled={createAction.disabled}
        />
      ) : null}
      <Button
        htmlType="button"
        variant="tertiary"
        size="small"
        icon={<RefreshCw size={13} />}
        iconOnly
        loading={refreshing}
        loadingSpinIcon
        className="h-7 w-7"
        aria-label={refreshLabel}
        onClick={onRefresh}
      />
    </>
  );
}

export interface GitHubWorkItemStateTab {
  key: string;
  label: string;
}

export function GitHubWorkItemStateTabs({
  tabs,
  activeTab,
  onChange,
}: {
  tabs: GitHubWorkItemStateTab[];
  activeTab: string;
  onChange: (key: string) => void;
}): ReactNode {
  const tabItems: TabPillItem[] = tabs.map((tab) => ({
    key: tab.key,
    label: tab.label,
    dataTestId: `github-work-items-state-${tab.key}`,
  }));

  return (
    <TabPill
      tabs={tabItems}
      activeTab={activeTab}
      onChange={onChange}
      variant="pill"
      color="fill"
      fillWidth={false}
      size="small"
      buttonStyle
      height={28}
    />
  );
}

export function GitHubWorkItemListFrame({
  height,
  children,
}: {
  height?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="bg-bg-0 overflow-hidden rounded-lg border border-border-2">
      <div
        className="w-full"
        style={height === undefined ? undefined : { height }}
      >
        {children}
      </div>
    </div>
  );
}

export function GitHubWorkItemRow({
  icon,
  content,
  trailing,
  actions,
}: {
  icon: ReactNode;
  content: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <div className="group flex min-h-[72px] w-full items-start gap-2.5 px-3 py-2.5 transition-colors focus-within:bg-fill-1/60 hover:bg-fill-1/60">
      <span className="mt-1 shrink-0">{icon}</span>
      {content}
      {actions}
      {trailing}
    </div>
  );
}

export function GitHubWorkItemPagination({
  totalLabel,
  previousLabel,
  nextLabel,
  loadingNext,
  canGoPrevious,
  canGoNext,
  onPrevious,
  onNext,
}: {
  totalLabel: ReactNode;
  previousLabel: string;
  nextLabel: string;
  loadingNext: boolean;
  canGoPrevious: boolean;
  canGoNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}): ReactNode {
  // Shares the session-table pagination footer look (PAGE_ICON_BUTTON prev/next
  // + text-xs label) while keeping the surface's load-more behavior.
  return (
    <div className="flex h-12 shrink-0 items-center justify-center gap-2 border-t border-border-2 px-3">
      <button
        type="button"
        className={PAGE_ICON_BUTTON}
        disabled={!canGoPrevious}
        onClick={onPrevious}
        aria-label={previousLabel}
        title={previousLabel}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="min-w-20 text-center text-xs text-text-1">
        {totalLabel}
      </span>
      <button
        type="button"
        className={PAGE_ICON_BUTTON}
        disabled={!canGoNext || loadingNext}
        onClick={onNext}
        aria-label={nextLabel}
        title={nextLabel}
      >
        {loadingNext ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <ChevronRight size={14} />
        )}
      </button>
    </div>
  );
}
