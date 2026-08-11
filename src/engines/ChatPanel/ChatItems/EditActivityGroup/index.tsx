/**
 * EditActivityGroup
 *
 * Groups file edits and the reads performed after them into one collapsible
 * stack. Each event still renders through the event registry.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getToolIcon } from "@src/config/toolIcons";
import { DIFF_STATS } from "@src/config/workstation/tokens";
import ToolUsageBadge from "@src/engines/ChatPanel/blocks/ToolCallBlock/ToolUsageBadge";
import { StackedBlock } from "@src/engines/ChatPanel/blocks/primitives";
import { type SessionEvent } from "@src/engines/SessionCore/core/types";
import { extractEditData } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";

import {
  aggregateActivityGroupToolUsage,
  buildActivityGroupItems,
  renderActivityGroupEvent,
} from "../activityGroupProjection";

interface EditActivityGroupProps {
  events: SessionEvent[];
  closedByBoundary?: boolean;
}

function getCanonicalName(event: SessionEvent): string {
  return (
    event.uiCanonical ||
    normalizeFunctionName(event.functionName || event.actionType || "")
  );
}

export function countActivities(
  events: readonly SessionEvent[],
  kind: "edit" | "read"
): number {
  return events.reduce((count, event) => {
    const canonical = getCanonicalName(event);
    const matches =
      kind === "edit"
        ? canonical === "edit_file" || canonical === "delete_file"
        : canonical === "read_file";
    return matches ? count + 1 : count;
  }, 0);
}

export function sumEditDiffStats(events: readonly SessionEvent[]): {
  additions: number;
  deletions: number;
} {
  return events.reduce(
    (total, event) => {
      if (getCanonicalName(event) !== "edit_file") return total;
      const edit = extractEditData({
        eventId: event.id,
        eventType: "edit_file",
        functionName: event.functionName,
        args: event.args ?? {},
        result: event.result ?? {},
        status:
          event.displayStatus === "running"
            ? "running"
            : event.displayStatus === "failed"
              ? "failed"
              : "success",
        variant: "chat",
        context: "chat",
        rustExtracted: event.extracted,
      });
      total.additions += edit.linesAdded ?? 0;
      total.deletions += edit.linesRemoved ?? 0;
      return total;
    },
    { additions: 0, deletions: 0 }
  );
}

const EditActivityGroup: React.FC<EditActivityGroupProps> = ({
  events,
  closedByBoundary = true,
}) => {
  const { t } = useTranslation("sessions");
  const items = useMemo(() => buildActivityGroupItems(events), [events]);

  if (items.length === 0) return null;

  const editCount = countActivities(events, "edit");
  const readCount = countActivities(events, "read");
  const summaryParts = [t("tools.editSummary.edit", { count: editCount })];
  if (readCount > 0) {
    summaryParts.push(t("tools.editSummary.read", { count: readCount }));
  }
  const diffStats = sumEditDiffStats(events);
  const hasDiffStats = diffStats.additions > 0 || diffStats.deletions > 0;

  const firstEvent = items[0].event;
  const groupToolUsage = aggregateActivityGroupToolUsage(events);

  return (
    <div
      data-tool-call-event-id={firstEvent.id}
      data-tool-call-name={
        firstEvent.functionName ||
        firstEvent.uiCanonical ||
        firstEvent.actionType
      }
    >
      <StackedBlock
        items={items}
        icon={getToolIcon("edit_file", {
          size: 14,
          className: "text-text-2",
        })}
        label={t("tools.editFiles")}
        groupSummary={
          <span className="inline-flex items-center gap-1.5">
            <span>{summaryParts.join(t("tools.editSummary.separator"))}</span>
            {hasDiffStats && (
              <span className="inline-flex items-center font-normal">
                <span className="mr-1.5 text-text-3" aria-hidden="true">
                  ·
                </span>
                {diffStats.additions > 0 && (
                  <span className={DIFF_STATS.additions}>
                    +{diffStats.additions}
                  </span>
                )}
                {diffStats.deletions > 0 && (
                  <span
                    className={`${diffStats.additions > 0 ? "ml-1" : ""} ${DIFF_STATS.deletions}`.trim()}
                  >
                    -{diffStats.deletions}
                  </span>
                )}
              </span>
            )}
          </span>
        }
        defaultCollapsed={closedByBoundary}
        collapseWhen={closedByBoundary}
        eventId={firstEvent.id}
        rightContent={
          groupToolUsage ? <ToolUsageBadge usage={groupToolUsage} /> : undefined
        }
        renderItem={renderActivityGroupEvent}
      />
    </div>
  );
};

EditActivityGroup.displayName = "EditActivityGroup";

export default EditActivityGroup;
