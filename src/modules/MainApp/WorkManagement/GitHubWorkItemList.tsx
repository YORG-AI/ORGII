import { CheckCircle2, CircleDot, RefreshCw, SquarePen } from "lucide-react";
import type { ReactNode } from "react";

import Button from "@src/components/Button";
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
      <Button
        htmlType="button"
        variant="secondary"
        icon={<RefreshCw size={13} />}
        iconOnly
        loading={refreshing}
        loadingSpinIcon
        aria-label={refreshLabel}
        onClick={onRefresh}
      />
      {createAction ? (
        <Button
          htmlType="button"
          variant="secondary"
          icon={<SquarePen size={14} strokeWidth={2} />}
          iconOnly
          aria-label={createAction.label}
          onClick={createAction.onClick}
          disabled={createAction.disabled}
        />
      ) : null}
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
    icon:
      tab.key === "open" ? (
        <span className="flex items-center text-success-6">
          <CircleDot size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ) : (
        <span className="flex items-center text-purple-6">
          <CheckCircle2 size={14} strokeWidth={1.8} aria-hidden="true" />
        </span>
      ),
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
      height={32}
      buttonStyle
    />
  );
}
