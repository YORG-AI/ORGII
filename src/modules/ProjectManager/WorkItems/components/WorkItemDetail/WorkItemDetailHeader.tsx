import { type ReactNode, useRef, useState } from "react";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  ArrowDown02Icon,
  ArrowUp02Icon,
  BoxIcon,
  Delete02Icon,
  HugeiconsIcon,
  InformationCircleIcon,
  ListChecksIcon,
} from "@src/icons";
import {
  formatWorkItemShortId,
  isGitHubIssueStatus,
} from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { ProjectManagerBreadcrumbSegment } from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

export interface WorkItemDetailHeaderProps {
  workItem: WorkItemExtended;
  breadcrumbSegments?: readonly ProjectManagerBreadcrumbSegment[];
  breadcrumbProjectName?: string;
  breadcrumbIcon?: ReactNode;
  shortId?: string | null;
  propertiesOpen: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onTitleChange?: (title: string) => void;
  onNavigate: (direction: "prev" | "next") => void;
  onDeleteWorkItem?: (id: string) => void;
  onToggleProperties?: () => void;
  t: (key: string) => string;
}

type WorkItemDetailHeaderBreadcrumbProps = Pick<
  WorkItemDetailHeaderProps,
  | "workItem"
  | "breadcrumbSegments"
  | "breadcrumbProjectName"
  | "breadcrumbIcon"
  | "shortId"
  | "onTitleChange"
  | "t"
> & {
  onClose?: WorkItemDetailHeaderProps["onClose"];
};

interface WorkItemBreadcrumbTitleProps {
  title: string;
  fallbackTitle: string;
  shortId?: string | null;
  onTitleChange?: (title: string) => void;
  renameLabel: string;
  fillAvailableWidth?: boolean;
}

function WorkItemBreadcrumbTitle({
  title,
  fallbackTitle,
  shortId,
  onTitleChange,
  renameLabel,
  fillAvailableWidth = false,
}: WorkItemBreadcrumbTitleProps) {
  const [draftState, setDraftState] = useState({
    sourceTitle: title,
    value: title,
  });
  const [isEditing, setIsEditing] = useState(false);
  const cancelBlurRef = useRef(false);
  const draftTitle =
    isEditing || draftState.sourceTitle === title ? draftState.value : title;

  const commitTitle = () => {
    setIsEditing(false);
    if (draftTitle !== title) onTitleChange?.(draftTitle);
  };

  const displayLength = Array.from(draftTitle || fallbackTitle).length;
  const shortIdLength = shortId ? Array.from(shortId).length + 3 : 0;
  const maxTitleLength = Math.max(12, 36 - shortIdLength);
  const inputWidth = Math.min(Math.max(displayLength + 1, 4), maxTitleLength);

  return (
    <span
      className={`inline-flex min-w-0 items-center gap-1 ${
        fillAvailableWidth ? "flex-1" : "max-w-[36ch]"
      }`}
    >
      {shortId ? <span className="shrink-0">{shortId} ·</span> : null}
      {onTitleChange ? (
        <Input
          type="text"
          value={draftTitle}
          onChange={(value) => setDraftState({ sourceTitle: title, value })}
          onFocus={() => {
            setIsEditing(true);
            setDraftState({ sourceTitle: title, value: draftTitle });
          }}
          onBlur={() => {
            if (cancelBlurRef.current) {
              cancelBlurRef.current = false;
              return;
            }
            commitTitle();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancelBlurRef.current = true;
              setDraftState({ sourceTitle: title, value: title });
              setIsEditing(false);
              event.currentTarget.blur();
            }
          }}
          placeholder={fallbackTitle}
          aria-label={renameLabel}
          data-testid="work-item-header-title-input"
          appearance="ghost"
          className="min-w-[4ch]"
          style={{ width: `${inputWidth}ch` }}
        />
      ) : (
        <span
          className={
            fillAvailableWidth
              ? "min-w-0 flex-1 whitespace-nowrap"
              : "min-w-0 truncate"
          }
        >
          {title || fallbackTitle}
        </span>
      )}
    </span>
  );
}

export function WorkItemDetailHeaderBreadcrumb({
  workItem,
  breadcrumbSegments,
  breadcrumbProjectName,
  breadcrumbIcon,
  shortId,
  onClose,
  onTitleChange,
  t,
}: WorkItemDetailHeaderBreadcrumbProps) {
  const workItemName = workItem.name || t("workItems.untitled");
  const workItemStatus = workItem.workItemStatus ?? workItem.status;
  const isGitHubIssue = isGitHubIssueStatus(workItemStatus);
  const displayShortId = formatWorkItemShortId(
    shortId,
    workItemStatus,
    breadcrumbProjectName
  );
  const title = displayShortId
    ? `${displayShortId} · ${workItemName}`
    : workItemName;
  const identityIcon = isGitHubIssue ? (
    <IntegrationIcon
      type={STORY_SYNC_ADAPTER.GITHUB}
      size={HEADER_ICON_SIZE.sm}
    />
  ) : (
    breadcrumbIcon
  );
  const titleContent = (
    <WorkItemBreadcrumbTitle
      title={workItem.name || ""}
      fallbackTitle={t("workItems.untitled")}
      shortId={displayShortId}
      onTitleChange={onTitleChange}
      renameLabel={t("workItems.contextMenu.rename")}
      fillAvailableWidth={isGitHubIssue}
    />
  );
  const fallbackParentSegments: readonly ProjectManagerBreadcrumbSegment[] =
    breadcrumbProjectName ? [{ label: breadcrumbProjectName }] : [];
  const parentSegments = (breadcrumbSegments ?? fallbackParentSegments).map(
    (segment, index, segments) =>
      index === segments.length - 1 && onClose
        ? {
            ...segment,
            onClick: onClose,
            title: `${t("common:actions.back")}: ${segment.label}`,
          }
        : segment
  );
  const segments: readonly ProjectManagerBreadcrumbSegment[] = [
    ...parentSegments,
    {
      label: title,
      content: titleContent,
      fillAvailableWidth: isGitHubIssue,
      icon:
        identityIcon ??
        (parentSegments.length > 0 ? (
          <HugeiconsIcon
            icon={BoxIcon}
            data-icon="box"
            size={HEADER_ICON_SIZE.sm}
            strokeWidth={1.75}
          />
        ) : (
          <HugeiconsIcon
            icon={ListChecksIcon}
            data-icon="list-checks"
            size={HEADER_ICON_SIZE.sm}
            strokeWidth={1.75}
          />
        )),
    },
  ];

  return <ProjectManagerBreadcrumb segments={segments} />;
}

type WorkItemDetailHeaderActionsProps = Omit<
  WorkItemDetailHeaderProps,
  | "breadcrumbSegments"
  | "breadcrumbProjectName"
  | "breadcrumbIcon"
  | "shortId"
  | "onClose"
  | "onTitleChange"
>;

export function WorkItemDetailHeaderActions({
  workItem,
  propertiesOpen,
  hasPrev,
  hasNext,
  onNavigate,
  onDeleteWorkItem,
  onToggleProperties,
  t,
}: WorkItemDetailHeaderActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-px">
      <ToolbarTooltip label={t("common:actions.previous")}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={() => onNavigate("prev")}
          disabled={!hasPrev}
          aria-label={t("common:actions.previous")}
          icon={
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              data-icon="arrow-up"
              size={HEADER_ICON_SIZE.sm}
            />
          }
        />
      </ToolbarTooltip>
      <ToolbarTooltip label={t("common:actions.next")}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={() => onNavigate("next")}
          disabled={!hasNext}
          aria-label={t("common:actions.next")}
          icon={
            <HugeiconsIcon
              icon={ArrowDown02Icon}
              data-icon="arrow-down"
              size={HEADER_ICON_SIZE.sm}
            />
          }
        />
      </ToolbarTooltip>
      {(onDeleteWorkItem || onToggleProperties) && (
        <div
          className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
          role="separator"
          aria-hidden
        />
      )}
      {onDeleteWorkItem && (
        <ToolbarTooltip label={t("workItems.deleteWorkItem")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onDeleteWorkItem(workItem.session_id)}
            aria-label={t("workItems.deleteWorkItem")}
            data-testid="work-item-delete"
            icon={
              <HugeiconsIcon
                icon={Delete02Icon}
                data-icon="trash-2"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
        </ToolbarTooltip>
      )}
      {onToggleProperties && (
        <ToolbarTooltip
          label={
            propertiesOpen
              ? t("workItems.hideProperties")
              : t("workItems.showProperties")
          }
        >
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            className={
              propertiesOpen ? "bg-surface-selected! text-primary-6!" : ""
            }
            onClick={onToggleProperties}
            aria-label={
              propertiesOpen
                ? t("workItems.hideProperties")
                : t("workItems.showProperties")
            }
            icon={
              <HugeiconsIcon
                icon={InformationCircleIcon}
                data-icon="info"
                size={HEADER_ICON_SIZE.sm}
              />
            }
          />
        </ToolbarTooltip>
      )}
    </div>
  );
}

export function WorkItemDetailHeader(props: WorkItemDetailHeaderProps) {
  const {
    breadcrumbSegments,
    breadcrumbProjectName,
    breadcrumbIcon,
    shortId,
    onClose,
    onTitleChange,
    workItem,
    t,
    ...actionProps
  } = props;

  return (
    <>
      <WorkItemDetailHeaderBreadcrumb
        workItem={workItem}
        breadcrumbSegments={breadcrumbSegments}
        breadcrumbProjectName={breadcrumbProjectName}
        breadcrumbIcon={breadcrumbIcon}
        shortId={shortId}
        onClose={onClose}
        onTitleChange={onTitleChange}
        t={t}
      />
      <WorkItemDetailHeaderActions {...actionProps} workItem={workItem} t={t} />
    </>
  );
}
