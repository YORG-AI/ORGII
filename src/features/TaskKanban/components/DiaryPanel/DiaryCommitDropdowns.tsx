/**
 * Commit marker tooltip/dropdown UI components for DiaryPanel.
 * Extracted to keep DiaryPanel/index.tsx under the 600-line limit.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import { DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import type { GanttMarker } from "@src/features/GanttChart";
import {
  Clock01Icon,
  GitCommitHorizontalIcon,
  HashtagIcon,
  HugeiconsIcon,
  UserCircleIcon,
} from "@src/icons";

import type { DiaryCommitMarker } from "../../utils/diaryUtils";
import {
  formatDateTime,
  formatTime,
  getCommitBucketRangeLabel,
} from "./diaryPanelUtils";

// ============================================================================
// DiaryCommitHoverCardRow
// ============================================================================

interface DiaryCommitHoverCardRowProps {
  icon: React.ReactNode;
  children: React.ReactNode;
}

export const DiaryCommitHoverCardRow: React.FC<
  DiaryCommitHoverCardRowProps
> = ({ icon, children }) => (
  <div className="grid grid-cols-[16px_minmax(0,1fr)] items-start gap-2 text-[13px] leading-5 text-text-2">
    <span className="mt-0.5 flex h-4 w-4 items-center justify-center text-text-3">
      {icon}
    </span>
    <div className="min-w-0">{children}</div>
  </div>
);

// ============================================================================
// DiaryCommitHoverCardContent
// ============================================================================

interface DiaryCommitHoverCardContentProps {
  marker: DiaryCommitMarker;
  t: (key: string) => string;
}

export const DiaryCommitHoverCardContent: React.FC<
  DiaryCommitHoverCardContentProps
> = ({ marker, t }) => {
  const commit = marker.commit;
  const title = commit.summary || commit.short_sha;

  return (
    <div className="rounded-xl border border-border-2 bg-bg-2 p-3 shadow-dropdown">
      <div
        className="mb-2 block max-w-full overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap text-text-1"
        title={title}
      >
        {title}
      </div>
      <div className="space-y-2">
        <DiaryCommitHoverCardRow
          icon={
            <HugeiconsIcon
              icon={GitCommitHorizontalIcon}
              data-icon="git-commit-horizontal"
              size={DROPDOWN_ITEM.iconSize}
              strokeWidth={1.75}
            />
          }
        >
          <div className="truncate text-text-2" title={commit.sha}>
            <span className="text-text-3">{t("gitDashboard.commits")}</span>
            <span className="mx-1 text-text-4">·</span>
            <span>{commit.short_sha}</span>
          </div>
        </DiaryCommitHoverCardRow>
        <DiaryCommitHoverCardRow
          icon={
            <HugeiconsIcon
              icon={Clock01Icon}
              data-icon="clock"
              size={DROPDOWN_ITEM.iconSize}
              strokeWidth={1.75}
            />
          }
        >
          <div
            className="truncate text-text-2"
            title={marker.timestamp.toISOString()}
          >
            <span className="text-text-3">{t("common.time")}</span>
            <span className="mx-1 text-text-4">·</span>
            <span>{formatDateTime(marker.timestamp)}</span>
          </div>
        </DiaryCommitHoverCardRow>
        <DiaryCommitHoverCardRow
          icon={
            <HugeiconsIcon
              icon={UserCircleIcon}
              data-icon="user-round"
              size={DROPDOWN_ITEM.iconSize}
              strokeWidth={1.75}
            />
          }
        >
          <div className="truncate text-text-2" title={commit.author.email}>
            <span className="text-text-3">{t("gitDashboard.author")}</span>
            <span className="mx-1 text-text-4">·</span>
            <span>{commit.author.name}</span>
          </div>
        </DiaryCommitHoverCardRow>
        {marker.task && (
          <DiaryCommitHoverCardRow
            icon={
              <HugeiconsIcon
                icon={HashtagIcon}
                data-icon="hash"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2" title={marker.task.title}>
              <span className="text-text-3">{t("terminology.session")}</span>
              <span className="mx-1 text-text-4">·</span>
              <span>{marker.task.title}</span>
            </div>
          </DiaryCommitHoverCardRow>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// DiaryCommitDetailsDropdown
// ============================================================================

interface DiaryCommitDetailsDropdownProps {
  marker: DiaryCommitMarker;
  children: React.ReactElement;
}

export const DiaryCommitDetailsDropdown: React.FC<
  DiaryCommitDetailsDropdownProps
> = ({ marker, children }) => {
  const { t } = useTranslation("common");

  return (
    <Dropdown
      trigger="hover"
      hoverCloseDelayMs={0}
      position="right-start"
      droplist={<DiaryCommitHoverCardContent marker={marker} t={t} />}
      getPopupContainer={() => document.body}
      className="w-[280px]"
      avoidViewportOverflow
    >
      {children}
    </Dropdown>
  );
};

// ============================================================================
// DiaryCommitBucketDropdown
// ============================================================================

interface DiaryCommitBucketDropdownProps {
  bucketCommits: DiaryCommitMarker[];
  marker: GanttMarker;
  children: React.ReactElement;
}

export const DiaryCommitBucketDropdown: React.FC<
  DiaryCommitBucketDropdownProps
> = ({ bucketCommits, marker, children }) => {
  const rangeLabel = marker.title;
  const countLabel = `${bucketCommits.length} ${
    bucketCommits.length === 1 ? "commit" : "commits"
  }`;

  return (
    <Dropdown
      trigger="hover"
      hoverCloseDelayMs={0}
      position="bottom-start"
      droplist={
        <DropdownPanel
          className="w-[320px] p-1"
          animated={false}
          maxHeight="none"
        >
          <div className="flex items-center justify-between gap-3 px-2 py-1.5 text-[12px]">
            <span className="truncate text-text-2">{rangeLabel}</span>
            <span className="shrink-0 rounded bg-fill-1 px-1.5 py-0.5 text-[10px] text-text-2">
              {countLabel}
            </span>
          </div>
          <div className={DROPDOWN_CLASSES.itemsColumn}>
            {bucketCommits.map((commitMarker) => {
              const commit = commitMarker.commit;
              const title = commit.summary || commit.short_sha;
              return (
                <DiaryCommitDetailsDropdown
                  key={commitMarker.id}
                  marker={commitMarker}
                >
                  <button
                    type="button"
                    className={`${DROPDOWN_CLASSES.item} ${DROPDOWN_CLASSES.itemHover} w-full min-w-0 justify-start text-left`}
                  >
                    <HugeiconsIcon
                      icon={GitCommitHorizontalIcon}
                      data-icon="git-commit-horizontal"
                      size={DROPDOWN_ITEM.iconSize}
                      strokeWidth={1.75}
                      className="shrink-0 text-text-3"
                    />
                    <span className="min-w-0 flex-1 truncate" title={title}>
                      {title}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-3">
                      {commit.short_sha}
                    </span>
                    <span className="shrink-0 text-[11px] text-text-2">
                      {formatTime(commitMarker.timestamp)}
                    </span>
                  </button>
                </DiaryCommitDetailsDropdown>
              );
            })}
          </div>
        </DropdownPanel>
      }
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      {children}
    </Dropdown>
  );
};

export function getCommitBucketRangeLabelForMarker(
  marker: GanttMarker
): string {
  return getCommitBucketRangeLabel(new Date(marker.timestamp));
}
