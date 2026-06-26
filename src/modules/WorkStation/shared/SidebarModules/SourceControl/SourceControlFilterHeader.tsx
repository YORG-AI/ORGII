/**
 * SourceControlFilterHeader
 *
 * Filter-mode select (Uncommitted / Unstaged / Staged / Branch) + optional
 * refresh button, designed for the Source Control 40px workstation header.
 * Shared Source Control filter header for Diff and Source Control tabs so their
 * tab-specific sidebar gets the same filter UX across every host.
 *
 * Repo-agnostic: all state is owned by the caller (`useSourceControlSidebarModule`).
 */
import { Ellipsis, RefreshCw } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import type { DropdownOption } from "@src/components/Dropdown/types";
import Select from "@src/components/Select";
import { useRefreshSpin } from "@src/hooks/ui";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared/WorkstationToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";

export type SourceControlFilterMode =
  | "uncommitted"
  | "unstaged"
  | "staged"
  | "stashed"
  | "history"
  | "pr"
  | "issues";

export interface SourceControlFilterCounts {
  uncommitted: number;
  unstaged: number;
  staged: number;
  stashed: number;
}

interface FilterRowEntry {
  id: SourceControlFilterMode;
  labelKey: string;
}

const FILE_FILTER_ROWS: FilterRowEntry[] = [
  {
    id: "uncommitted",
    labelKey: "controlTower.git.filterUncommitted",
  },
  {
    id: "unstaged",
    labelKey: "controlTower.git.filterUnstaged",
  },
  { id: "staged", labelKey: "controlTower.git.filterStaged" },
  {
    id: "stashed",
    labelKey: "controlTower.git.filterStashed",
  },
];

export interface SourceControlFilterHeaderProps {
  /** Active filter mode. */
  mode: SourceControlFilterMode;
  /** Pick a new filter mode. */
  onChangeMode: (mode: SourceControlFilterMode) => void;
  /** Refresh git status. */
  onRefresh: () => void;
  /** Whether refresh is in progress (drives spin animation). */
  refreshLoading?: boolean;
  /** Stable id used to scope the refresh-spin animation. */
  spinScope?: string;
  /** Whether to show the refresh action next to the filter select. */
  showRefresh?: boolean;
  /** Counts shown in the trigger label. */
  counts?: SourceControlFilterCounts;
}

const SourceControlFilterHeader: React.FC<SourceControlFilterHeaderProps> =
  memo(
    ({
      mode,
      onChangeMode,
      onRefresh,
      refreshLoading = false,
      spinScope,
      showRefresh = true,
      counts,
    }) => {
      const { t } = useTranslation("sessions");

      const getModeCount = useCallback(
        (modeId: SourceControlFilterMode) => {
          if (
            !counts ||
            modeId === "history" ||
            modeId === "pr" ||
            modeId === "issues"
          )
            return undefined;
          return counts[modeId];
        },
        [counts]
      );

      const getCountLabel = useCallback(
        (count: number, label: string) =>
          t("controlTower.git.filterCountLabel", {
            count,
            label: label.toLowerCase(),
          }),
        [t]
      );

      const options = useMemo<DropdownOption[]>(() => {
        const fileOptions = FILE_FILTER_ROWS.map((row) => {
          const label = t(row.labelKey);
          const count = getModeCount(row.id);
          const triggerLabel =
            typeof count === "number" ? getCountLabel(count, label) : label;
          return {
            value: row.id,
            label: <span className="whitespace-nowrap">{triggerLabel}</span>,
            triggerLabel,
          };
        });

        return [
          ...fileOptions,
          {
            value: "history",
            label: (
              <span className="whitespace-nowrap">
                {t("common:labels.gitHistory")}
              </span>
            ),
            triggerLabel: t("common:labels.gitHistory"),
          },
          {
            value: "pr",
            label: (
              <span className="whitespace-nowrap">
                {t("common:labels.pullRequest", "Pull request")}
              </span>
            ),
            triggerLabel: t("common:labels.pullRequest", "Pull request"),
          },
          {
            value: "issues",
            label: (
              <span className="whitespace-nowrap">
                {t("common:labels.issues", "Issues")}
              </span>
            ),
            triggerLabel: t("common:labels.issues", "Issues"),
          },
        ];
      }, [getCountLabel, getModeCount, t]);

      const [moreMenuVisible, setMoreMenuVisible] = useState(false);

      const handleSelect = useCallback(
        (nextMode: string | number | (string | number)[]) => {
          if (Array.isArray(nextMode)) return;
          onChangeMode(nextMode as SourceControlFilterMode);
        },
        [onChangeMode]
      );

      const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
        useRefreshSpin(onRefresh, refreshLoading, spinScope);
      const handleRefreshMenuClick = useCallback(() => {
        handleRefreshClick();
        setMoreMenuVisible(false);
      }, [handleRefreshClick]);

      return (
        <div className="flex flex-none items-center gap-1 overflow-visible">
          <Select
            value={mode}
            onChange={handleSelect}
            options={options}
            size="small"
            variant="ghost"
            radius="lg"
            dropdownWidthMode="auto"
            className="w-auto"
          />

          {showRefresh && (
            <Dropdown
              droplist={
                <div className={DROPDOWN_CLASSES.menuPanel}>
                  <button
                    type="button"
                    onClick={handleRefreshMenuClick}
                    className={DROPDOWN_CLASSES.menuActionItem}
                  >
                    <RefreshCw
                      size={HEADER_ICON_SIZE.sm}
                      className={refreshSpinClass}
                    />
                    <span>
                      {t("controlTower.diff.refresh", "Refresh Git status")}
                    </span>
                  </button>
                </div>
              }
              position="bottom-end"
              trigger="click"
              popupVisible={moreMenuVisible}
              onVisibleChange={setMoreMenuVisible}
            >
              <WorkstationToolbarTooltip
                label={t("common:actions.more")}
                disabled={moreMenuVisible}
              >
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  className={
                    moreMenuVisible ? "!bg-fill-2 !text-primary-6" : ""
                  }
                  icon={
                    <Ellipsis size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
                  }
                />
              </WorkstationToolbarTooltip>
            </Dropdown>
          )}
        </div>
      );
    }
  );
SourceControlFilterHeader.displayName = "SourceControlFilterHeader";

export default SourceControlFilterHeader;
