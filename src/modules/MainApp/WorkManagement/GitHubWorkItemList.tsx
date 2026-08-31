import type { ReactNode } from "react";

import Button from "@src/components/Button";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  HugeiconsIcon,
  PencilEdit02Icon,
  Refresh04Icon,
} from "@src/icons";

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
        icon={
          <HugeiconsIcon
            icon={Refresh04Icon}
            data-icon="refresh-cw"
            size={13}
          />
        }
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
          icon={
            <HugeiconsIcon
              icon={PencilEdit02Icon}
              data-icon="square-pen"
              size={14}
              strokeWidth={2}
            />
          }
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
          <HugeiconsIcon
            icon={CircleDotIcon}
            data-icon="circle-dot"
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </span>
      ) : (
        <span className="flex items-center text-purple-6">
          <HugeiconsIcon
            icon={CheckmarkCircle01Icon}
            data-icon="check-circle-2"
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
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
