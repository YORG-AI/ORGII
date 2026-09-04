import React from "react";
import { useTranslation } from "react-i18next";

import { ActivityTimestamp } from "@src/modules/shared/components/ActivityTimeline";
import DetailFlowHeader from "@src/modules/shared/components/DetailFlowHeader";
import type { WorkItem } from "@src/types/core/workItem";

import { formatWorkItemShortId } from "../workItemIdentity";

interface WorkItemFlowHeaderProps {
  workItem: WorkItem;
  shortId?: string | null;
  actorName?: string;
}

/** PR-format full title and creation summary for a Work Item conversation. */
export default function WorkItemFlowHeader({
  workItem,
  shortId,
  actorName,
}: WorkItemFlowHeaderProps): React.ReactNode {
  const { t } = useTranslation(["projects", "common"]);
  const status = workItem.workItemStatus ?? workItem.status;
  const displayShortId = formatWorkItemShortId(
    shortId ?? workItem.shortId,
    status
  );
  const creatorName =
    actorName ??
    workItem.createdBy?.name ??
    workItem.user_id ??
    t("workItems.activity.system");

  return (
    <DetailFlowHeader
      title={workItem.name || t("workItems.untitled")}
      identifier={displayShortId}
      status={
        <span className="inline-flex shrink-0 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] font-medium text-text-2">
          {t(`workItems.statusLabels.${status}`, { defaultValue: status })}
        </span>
      }
      actor={{
        login: creatorName,
        avatarUrl: workItem.createdBy?.avatar ?? "",
      }}
      unknownActorLabel={t("workItems.activity.system")}
      ariaLabel={t("workItems.detailSummary", {
        defaultValue: "Work Item summary",
      })}
      testIdPrefix="work-item-flow"
    >
      <span>
        {t("workItems.activity.openedWorkItem", "opened this work item")}
      </span>
      <ActivityTimestamp timestamp={workItem.created_time} />
      <span aria-hidden>·</span>
      <span>
        {t("common:git.issues.commentCount", {
          count: workItem.comments?.length ?? 0,
          defaultValue: "{{count}} comment",
          defaultValue_other: "{{count}} comments",
        })}
      </span>
    </DetailFlowHeader>
  );
}
