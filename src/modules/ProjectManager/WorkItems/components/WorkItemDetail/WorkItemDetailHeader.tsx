import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Box,
  Info,
  ListChecks,
  Trash2,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import {
  formatWorkItemShortId,
  isGitHubIssueStatus,
} from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import ProjectManagerBreadcrumb from "@src/modules/ProjectManager/shared/components/ProjectManagerBreadcrumb";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

export interface WorkItemDetailHeaderProps {
  workItem: WorkItemExtended;
  pendingUpdates: Partial<WorkItemExtended>;
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
  onExpandToTab?: (pendingUpdates: Partial<WorkItemExtended>) => void;
  onToggleProperties?: () => void;
  t: (key: string) => string;
}

type WorkItemDetailHeaderBreadcrumbProps = Pick<
  WorkItemDetailHeaderProps,
  | "workItem"
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
          fieldVariant="ghost"
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
  const segments = breadcrumbProjectName
    ? [
        {
          label: breadcrumbProjectName,
          onClick: onClose,
          title: onClose
            ? `${t("common:actions.back")}: ${breadcrumbProjectName}`
            : breadcrumbProjectName,
        },
        {
          label: title,
          content: titleContent,
          fillAvailableWidth: isGitHubIssue,
          icon: identityIcon ?? (
            <Box size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          ),
        },
      ]
    : [
        {
          label: title,
          content: titleContent,
          fillAvailableWidth: isGitHubIssue,
          icon: identityIcon ?? (
            <ListChecks size={HEADER_ICON_SIZE.sm} strokeWidth={1.75} />
          ),
        },
      ];

  return <ProjectManagerBreadcrumb segments={segments} />;
}

type WorkItemDetailHeaderActionsProps = Omit<
  WorkItemDetailHeaderProps,
  | "breadcrumbProjectName"
  | "breadcrumbIcon"
  | "shortId"
  | "onClose"
  | "onTitleChange"
>;

export function WorkItemDetailHeaderActions({
  workItem,
  pendingUpdates,
  propertiesOpen,
  hasPrev,
  hasNext,
  onNavigate,
  onDeleteWorkItem,
  onExpandToTab,
  onToggleProperties,
  t,
}: WorkItemDetailHeaderActionsProps) {
  return (
    <div className="flex flex-shrink-0 items-center gap-px">
      <WorkstationToolbarTooltip label={t("common:actions.previous")}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={() => onNavigate("prev")}
          disabled={!hasPrev}
          aria-label={t("common:actions.previous")}
          icon={<ArrowUp size={HEADER_ICON_SIZE.sm} />}
        />
      </WorkstationToolbarTooltip>
      <WorkstationToolbarTooltip label={t("common:actions.next")}>
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          onClick={() => onNavigate("next")}
          disabled={!hasNext}
          aria-label={t("common:actions.next")}
          icon={<ArrowDown size={HEADER_ICON_SIZE.sm} />}
        />
      </WorkstationToolbarTooltip>
      {(onExpandToTab || onDeleteWorkItem || onToggleProperties) && (
        <div
          className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
          role="separator"
          aria-hidden
        />
      )}
      {onExpandToTab && (
        <WorkstationToolbarTooltip label={t("common:actions.openInNewTab")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onExpandToTab(pendingUpdates)}
            aria-label={t("common:actions.openInNewTab")}
            icon={<ArrowUpRight size={HEADER_ICON_SIZE.md} />}
          />
        </WorkstationToolbarTooltip>
      )}
      {onDeleteWorkItem && (
        <WorkstationToolbarTooltip label={t("workItems.deleteWorkItem")}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => onDeleteWorkItem(workItem.session_id)}
            aria-label={t("workItems.deleteWorkItem")}
            data-testid="work-item-delete"
            icon={<Trash2 size={HEADER_ICON_SIZE.sm} />}
          />
        </WorkstationToolbarTooltip>
      )}
      {onToggleProperties && (
        <WorkstationToolbarTooltip
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
              propertiesOpen ? "!bg-surface-selected !text-primary-6" : ""
            }
            onClick={onToggleProperties}
            aria-label={
              propertiesOpen
                ? t("workItems.hideProperties")
                : t("workItems.showProperties")
            }
            icon={<Info size={HEADER_ICON_SIZE.sm} />}
          />
        </WorkstationToolbarTooltip>
      )}
    </div>
  );
}

export function WorkItemDetailHeader(props: WorkItemDetailHeaderProps) {
  const {
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
