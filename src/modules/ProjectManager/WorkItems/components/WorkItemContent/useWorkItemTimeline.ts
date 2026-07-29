import { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  WORK_ITEM_HISTORY_ACTION,
  type WorkItemHistoryChange,
  type WorkItemHistoryEvent,
} from "@src/api/http/project/types";
import type { Person } from "@src/types/core/shared";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";
import { formatDate } from "@src/util/data/formatters/date";

import { describeTodoHistoryChange } from "./todoHistory";
import type { TimelineEntry } from "./types";

interface UseWorkItemTimelineOptions {
  workItem: WorkItemExtended;
  teamMembers: Person[];
}

type TimelineTranslator = (
  key: string,
  options?: Record<string, unknown>
) => string;

export function useWorkItemTimeline({
  workItem,
  teamMembers,
}: UseWorkItemTimelineOptions) {
  const { t } = useTranslation("projects");

  const timelineEntries = useMemo(
    () => buildWorkItemTimelineEntries(workItem, t, teamMembers),
    [workItem, t, teamMembers]
  );

  const lastUpdatedRef = useRef(workItem.updated_time);

  return {
    timelineEntries,
    lastUpdatedRef,
  };
}

export function buildWorkItemTimelineEntries(
  workItem: WorkItemExtended,
  t: TimelineTranslator,
  teamMembers: readonly Person[] = []
): TimelineEntry[] {
  const memberById = new Map(teamMembers.map((member) => [member.id, member]));
  const entries =
    workItem.history?.map((event) =>
      historyEventToTimelineEntry(event, t, memberById)
    ) ?? [];
  const existingCommentIds = commentIdsFromHistory(workItem.history ?? []);

  for (const comment of workItem.comments ?? []) {
    if (existingCommentIds.has(comment.id)) {
      continue;
    }

    const author = memberById.get(comment.author);
    entries.push({
      id: comment.id,
      timestamp: comment.created_at,
      type: WORK_ITEM_HISTORY_ACTION.COMMENTED,
      actorId: comment.author,
      userName: author?.name ?? comment.author,
      userAvatar: author?.avatar,
      userColor: author?.color,
      descriptions: [comment.content || t("workItems.activity.commented")],
    });
  }

  entries.sort(
    (entryA, entryB) =>
      new Date(entryA.timestamp).getTime() -
      new Date(entryB.timestamp).getTime()
  );

  return entries;
}

function commentIdsFromHistory(history: WorkItemHistoryEvent[]): Set<string> {
  return new Set(
    history
      .filter((event) => event.action === WORK_ITEM_HISTORY_ACTION.COMMENTED)
      .flatMap((event) => event.changes ?? [])
      .map((change) => commentIdFromValue(change.newValue))
      .filter((id): id is string => Boolean(id))
  );
}

function historyEventToTimelineEntry(
  event: WorkItemHistoryEvent,
  t: TimelineTranslator,
  memberById: ReadonlyMap<string, Person>
): TimelineEntry {
  const actor = event.actorId ? memberById.get(event.actorId) : undefined;
  return {
    id: event.id,
    timestamp: event.timestamp,
    type: event.action,
    actorId: event.actorId,
    userName:
      actor?.name ||
      event.actorName ||
      event.actorId ||
      t("workItems.activity.system"),
    userAvatar: actor?.avatar,
    userColor: actor?.color,
    descriptions: eventDescriptions(event, t),
    changeFields:
      event.action === WORK_ITEM_HISTORY_ACTION.UPDATED
        ? Array.from(
            new Set(
              (event.changes ?? []).map((change) =>
                fieldToLabel(change.field, t)
              )
            )
          )
        : undefined,
    changeFieldKeys:
      event.action === WORK_ITEM_HISTORY_ACTION.UPDATED
        ? Array.from(
            new Set((event.changes ?? []).map((change) => change.field))
          )
        : undefined,
  };
}

function eventDescriptions(
  event: WorkItemHistoryEvent,
  t: TimelineTranslator
): string[] {
  switch (event.action) {
    case WORK_ITEM_HISTORY_ACTION.CREATED:
      return [t("workItems.activity.createdWorkItem")];
    case WORK_ITEM_HISTORY_ACTION.DELETED:
      return [t("workItems.activity.deletedWorkItem")];
    case WORK_ITEM_HISTORY_ACTION.RESTORED:
      return [t("workItems.activity.restoredWorkItem")];
    case WORK_ITEM_HISTORY_ACTION.COMMENTED: {
      const content = (event.changes ?? [])
        .map((change) => commentContentFromValue(change.newValue))
        .find((value): value is string => Boolean(value));
      return [content || event.summary || t("workItems.activity.commented")];
    }
    case WORK_ITEM_HISTORY_ACTION.MOVED: {
      const projectChange = event.changes?.find(
        (change) => change.field === "project"
      );
      return [
        t("workItems.activity.movedFromTo", {
          from: valueToLabel(projectChange?.oldValue, "project", t),
          to: valueToLabel(projectChange?.newValue, "project", t),
        }),
      ];
    }
    case WORK_ITEM_HISTORY_ACTION.UPDATED:
    default: {
      const descriptions = (event.changes ?? []).flatMap((change) =>
        changeToDescriptions(change, t)
      );
      return descriptions.length > 0
        ? descriptions
        : [event.summary || t("workItems.activity.madeChange")];
    }
  }
}

function changeToDescriptions(
  change: WorkItemHistoryChange,
  t: TimelineTranslator
): string[] {
  if (change.field === "todos") {
    const todoDescriptions = describeTodoHistoryChange(
      change.oldValue,
      change.newValue,
      t
    );
    if (todoDescriptions) return todoDescriptions;
  }

  return [changeToDescription(change, t)];
}

function changeToDescription(
  change: WorkItemHistoryChange,
  t: TimelineTranslator
): string {
  const fieldLabel = fieldToLabel(change.field, t);
  if (change.field === "body") {
    return t("workItems.activity.changedDescription");
  }
  if (isEmptyValue(change.oldValue)) {
    return t("workItems.activity.setField", {
      field: fieldLabel,
      value: valueToLabel(change.newValue, change.field, t),
    });
  }
  if (isEmptyValue(change.newValue)) {
    return t("workItems.activity.clearedField", { field: fieldLabel });
  }
  if (isCompactValue(change.oldValue) && isCompactValue(change.newValue)) {
    return t("workItems.activity.changedField", {
      field: fieldLabel,
      from: valueToLabel(change.oldValue, change.field, t),
      to: valueToLabel(change.newValue, change.field, t),
    });
  }
  return t("workItems.activity.changedFieldShort", { field: fieldLabel });
}

function fieldToLabel(field: string, t: (key: string) => string): string {
  const keyByField: Record<string, string> = {
    title: "title",
    body: "description",
    status: "status",
    priority: "priority",
    project: "project",
    assignee: "assignee",
    assigneeType: "assigneeType",
    labels: "labels",
    milestone: "milestone",
    startDate: "startDate",
    targetDate: "targetDate",
    todos: "todos",
    comments: "comments",
    schedule: "schedule",
    orchestratorConfig: "orchestratorConfig",
  };
  return t(`workItems.activity.fields.${keyByField[field] ?? field}`);
}

function commentIdFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" ? record.id : undefined;
}

function commentContentFromValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.content === "string" ? record.content : undefined;
}

function valueToLabel(
  value: unknown,
  field: string,
  t: TimelineTranslator
): string {
  if (isEmptyValue(value)) return "—";
  if (typeof value === "string") {
    if (field === "startDate" || field === "targetDate") {
      return formatDate(value, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: undefined,
        minute: undefined,
      });
    }
    if (field === "status") {
      return t(`workItems.statusLabels.${value}`, {
        defaultValue: humanizeEnumValue(value),
      });
    }
    if (field === "priority") {
      return t(`workItems.priorityLabels.${value}`, {
        defaultValue: humanizeEnumValue(value),
      });
    }
    if (field === "assigneeType") {
      return humanizeEnumValue(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.every((item) => isCompactValue(item))) {
      return value.map((item) => valueToLabel(item, field, t)).join(", ");
    }
    return `${value.length}`;
  }
  if (typeof value === "object") return "…";
  return String(value);
}

function humanizeEnumValue(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  if (!words) return value;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function isCompactValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}
