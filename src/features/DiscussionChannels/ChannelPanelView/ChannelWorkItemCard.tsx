/**
 * A Work Item referenced by a posted channel message, rendered as a card.
 *
 * Same chrome as the session card (`ChannelReferenceCard`), different body:
 * a Work Item's useful summary is its id, title, status and priority, so the
 * card is read the way `WorkItemHoverCard` reads one — `getWorkItemStatusConfig`
 * / `getWorkItemPriorityConfig` for the glyph and the accent, and the
 * `projects:workItems.*Labels.*` namespace for the words. No colour, icon or
 * label is invented here; a status that changes meaning changes it in one
 * place and every surface follows.
 *
 * The item itself is resolved (and cached) by `useChannelWorkItem`. Clicking
 * hands the resolved payload to `openWorkItemInChatPanelTabAtom` — the same
 * call `useTeamInboxNavigation` makes — so a reference opens the real Work
 * Item panel rather than a channel-local preview.
 */
import { useSetAtom } from "jotai";
import { FolderKanban } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { formatWorkItemShortId } from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import {
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
  getWorkItemPriorityConfig,
  getWorkItemStatusConfig,
} from "@src/modules/ProjectManager/config/manage";
import { openWorkItemInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import type {
  WorkItemPriority,
  WorkItemStatus,
} from "@src/types/core/workItem";

import {
  ChannelReferenceCard,
  ChannelReferenceCardMeta,
  ChannelReferenceCardMetaItem,
  ChannelReferenceCardMissing,
  ChannelReferenceCardTitle,
} from "./ChannelReferenceCard";
import { useChannelWorkItem } from "./useChannelWorkItem";

const CARD_TEST_ID = "channel-work-item-card";

export interface ChannelWorkItemCardProps {
  projectSlug: string;
  shortId: string;
  /** Title as posted — the only thing left when the item cannot be read. */
  fallbackTitle: string;
}

/** Narrowed against the option tables, the way `WorkItemHoverCard` does it. */
function isWorkItemStatus(value: string): value is WorkItemStatus {
  return WORK_ITEM_STATUS_OPTIONS.some((option) => option.value === value);
}

function isWorkItemPriority(value: string): value is WorkItemPriority {
  return WORK_ITEM_PRIORITY_OPTIONS.some((option) => option.value === value);
}

const ChannelWorkItemCard: React.FC<ChannelWorkItemCardProps> = ({
  projectSlug,
  shortId,
  fallbackTitle,
}) => {
  const { t } = useTranslation(["navigation", "projects"]);
  const openWorkItem = useSetAtom(openWorkItemInChatPanelTabAtom);
  const { resolved, settled } = useChannelWorkItem({ projectSlug, shortId });

  const handleOpen = useCallback(() => {
    if (!resolved) return;
    openWorkItem({
      workItem: resolved.workItem,
      shortId: resolved.workItem.shortId ?? shortId,
      projectId: resolved.projectId,
      projectSlug,
      projectName: resolved.projectName,
      orgId: resolved.orgId,
    });
  }, [openWorkItem, projectSlug, resolved, shortId]);

  if (!resolved) {
    return (
      <ChannelReferenceCardMissing
        testId={CARD_TEST_ID}
        identity={{
          "data-work-item-id": `${projectSlug}/${shortId}`,
          ...(settled ? { "data-work-item-missing": "true" } : {}),
        }}
        title={fallbackTitle}
        note={t(
          settled
            ? "navigation:cloud.channels.feed.workItemCardMissing"
            : "navigation:cloud.channels.feed.workItemCardLoading"
        )}
      />
    );
  }

  const { workItem } = resolved;
  const status = workItem.workItemStatus ?? "backlog";
  const priority = workItem.priority ?? "none";
  const statusConfig = getWorkItemStatusConfig(status);
  const priorityConfig = getWorkItemPriorityConfig(priority);
  const title = workItem.name || fallbackTitle;
  const displayId =
    formatWorkItemShortId(workItem.shortId ?? shortId, status) ?? shortId;

  return (
    <ChannelReferenceCard
      testId={CARD_TEST_ID}
      identity={{ "data-work-item-id": `${projectSlug}/${shortId}` }}
      ariaLabel={t("navigation:cloud.channels.feed.workItemCardOpen", {
        name: title,
      })}
      onOpen={handleOpen}
    >
      <ChannelReferenceCardTitle
        icon={
          <span
            className="inline-flex items-center"
            style={{ color: statusConfig.color }}
          >
            {statusConfig.icon}
          </span>
        }
        title={title}
        trailing={
          <span
            className="text-[11px] tabular-nums text-text-3"
            data-testid="channel-work-item-card-id"
          >
            {displayId}
          </span>
        }
      />
      <ChannelReferenceCardMeta>
        {isWorkItemStatus(status) ? (
          <ChannelReferenceCardMetaItem color={statusConfig.color}>
            {t(`projects:workItems.statusLabels.${status}`)}
          </ChannelReferenceCardMetaItem>
        ) : null}
        {isWorkItemPriority(priority) && priority !== "none" ? (
          <ChannelReferenceCardMetaItem color={priorityConfig.color}>
            {t(`projects:workItems.priorityLabels.${priority}`)}
          </ChannelReferenceCardMetaItem>
        ) : null}
        <ChannelReferenceCardMetaItem
          icon={<FolderKanban size={11} strokeWidth={1.75} aria-hidden />}
        >
          {resolved.projectName}
        </ChannelReferenceCardMetaItem>
      </ChannelReferenceCardMeta>
    </ChannelReferenceCard>
  );
};

export default ChannelWorkItemCard;
