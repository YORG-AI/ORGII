import type { TFunction } from "i18next";
import {
  ArrowRightLeft,
  Bot,
  ChevronRight,
  MessageSquare,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";
import Avatar from "@src/components/Avatar";
import { projectMarkdownSessionReferences } from "@src/components/MarkDown/sessionReferenceProjection";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  ActivityTimestamp,
  ConnectedTimelineItem,
  TimelineCard,
  TimelineCardHeader,
  TimelineEventCard,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import { MarkdownContent } from "@src/modules/shared/components/MarkdownContent";
import type { Person } from "@src/types/core/shared";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import {
  type ActivityTimelineItem,
  groupActivityTimelineEntries,
} from "./activityTimelineModel";
import { isDiscussionEntry } from "./discussionTimelineModel";
import { resolveTimelineActorVisual } from "./timelineActorVisual";
import type { TimelineEntry } from "./types";

const MAX_VISIBLE_FIELD_LABELS = 2;

const TIMELINE_ICONS: Record<TimelineEntry["type"], React.ReactNode> = {
  [WORK_ITEM_HISTORY_ACTION.CREATED]: <Plus size={12} />,
  [WORK_ITEM_HISTORY_ACTION.UPDATED]: <Pencil size={12} />,
  [WORK_ITEM_HISTORY_ACTION.COMMENTED]: <MessageSquare size={12} />,
  [WORK_ITEM_HISTORY_ACTION.DELETED]: <Trash2 size={12} />,
  [WORK_ITEM_HISTORY_ACTION.RESTORED]: <RotateCcw size={12} />,
  [WORK_ITEM_HISTORY_ACTION.MOVED]: <ArrowRightLeft size={12} />,
};

interface WorkItemActivityTimelineProps {
  entries: TimelineEntry[];
  currentUser: Person;
  compact?: boolean;
  navigationEnabled?: boolean;
}

export function WorkItemActivityTimeline({
  entries,
  currentUser,
  compact = false,
  navigationEnabled = false,
}: WorkItemActivityTimelineProps): React.ReactNode {
  const items = useMemo(() => groupActivityTimelineEntries(entries), [entries]);

  if (items.length === 0) return null;

  return (
    <div className={compact ? "" : DETAIL_PANEL_TOKENS.sectionGap}>
      <TimelineStack>
        {items.map((item, itemIndex) => (
          <ConnectedTimelineItem
            key={item.id}
            isLast={itemIndex === items.length - 1}
            trailLabel={
              navigationEnabled
                ? getActivityTimelineTrailLabel(item)
                : undefined
            }
          >
            <ActivityTimelineItemView item={item} currentUser={currentUser} />
          </ConnectedTimelineItem>
        ))}
      </TimelineStack>
    </div>
  );
}

function getActivityTimelineTrailLabel(item: ActivityTimelineItem): string {
  if (item.kind === "change-group") {
    return `${item.actor.userName}: ${item.fieldLabels.join(", ")}`;
  }
  const description = item.entry.descriptions.join("; ");
  return description
    ? `${item.entry.userName}: ${description}`
    : item.entry.userName;
}

function ActivityTimelineItemView({
  item,
  currentUser,
}: {
  item: ActivityTimelineItem;
  currentUser: Person;
}): React.ReactNode {
  if (item.kind === "change-group") {
    return <GroupedChangeEvent item={item} />;
  }

  return <SingleTimelineEntry entry={item.entry} currentUser={currentUser} />;
}

function SingleTimelineEntry({
  entry,
  currentUser,
}: {
  entry: TimelineEntry;
  currentUser: Person;
}): React.ReactNode {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const isDelegationComment =
    entry.type === WORK_ITEM_HISTORY_ACTION.COMMENTED &&
    !isDiscussionEntry(entry);

  if (isDiscussionEntry(entry)) {
    const body = entry.descriptions[0] ?? "";
    const isSessionAttachment =
      projectMarkdownSessionReferences(body).referenceOnly;
    const actorVisual = resolveTimelineActorVisual(entry, currentUser);
    const timestampLabel = formatActivityTimestamp(
      entry.timestamp,
      t,
      i18n.resolvedLanguage
    );
    return (
      <TimelineCard
        copyBody={body}
        header={
          <TimelineCardHeader
            avatar={
              <Avatar
                size={18}
                src={actorVisual.avatar}
                style={
                  actorVisual.color
                    ? {
                        backgroundColor: actorVisual.color,
                        color: "var(--color-text-white)",
                      }
                    : undefined
                }
              >
                {entry.userName.charAt(0).toUpperCase()}
              </Avatar>
            }
            actor={entry.userName}
            action={t(
              isSessionAttachment
                ? "workItems.activity.appendedSession"
                : "workItems.activity.commented"
            )}
            timestamp={entry.timestamp}
            timestampLabel={timestampLabel}
          />
        }
      >
        <MarkdownContent body={body} fadeFrom="from-chat-pane" />
      </TimelineCard>
    );
  }

  return (
    <TimelineEventCard
      icon={
        isDelegationComment ? (
          <Bot size={12} className="text-primary-6" />
        ) : (
          TIMELINE_ICONS[entry.type]
        )
      }
    >
      <span
        className={
          isDelegationComment
            ? "font-medium text-primary-6"
            : "font-medium text-text-1"
        }
      >
        {isDelegationComment ? t("workItems.activity.agent") : entry.userName}
      </span>{" "}
      <EntryDescriptions entry={entry} />
      <span className="mx-1">·</span>
      <ActivityTimestamp
        timestamp={entry.timestamp}
        label={formatActivityTimestamp(
          entry.timestamp,
          t,
          i18n.resolvedLanguage
        )}
      />
    </TimelineEventCard>
  );
}

function GroupedChangeEvent({
  item,
}: {
  item: Extract<ActivityTimelineItem, { kind: "change-group" }>;
}): React.ReactNode {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const isTodoOnlyGroup =
    item.fieldKeys.length === 1 && item.fieldKeys[0] === "todos";
  const visibleFields = item.fieldLabels.slice(0, MAX_VISIBLE_FIELD_LABELS);
  const hiddenFieldCount = item.fieldLabels.length - visibleFields.length;

  return (
    <TimelineEventCard icon={<Pencil size={12} />}>
      <details
        className="group min-w-0"
        data-testid="work-item-activity-change-group"
      >
        <summary className="flex min-h-5 cursor-pointer list-none items-center gap-1.5 marker:hidden [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 flex-1">
            <span className="font-medium text-text-1">
              {item.actor.userName}
            </span>{" "}
            <span>
              {t(
                isTodoOnlyGroup
                  ? "workItems.activity.groupedTodoChanges"
                  : "workItems.activity.groupedChanges",
                {
                  count: item.changeCount,
                }
              )}
            </span>
            {!isTodoOnlyGroup && visibleFields.length > 0 ? (
              <span
                className="ml-1.5 inline-flex flex-wrap items-center gap-1 align-middle"
                aria-label={item.fieldLabels.join(", ")}
              >
                {visibleFields.map((fieldLabel) => (
                  <span
                    key={fieldLabel}
                    className="rounded-full bg-fill-2 px-1.5 py-px text-xs font-medium text-text-3"
                  >
                    {fieldLabel}
                  </span>
                ))}
                {hiddenFieldCount > 0 ? (
                  <span className="text-xs text-text-4">
                    +{hiddenFieldCount}
                  </span>
                ) : null}
              </span>
            ) : null}
            <span className="mx-1">·</span>
            <ActivityTimestamp
              timestamp={item.timestamp}
              label={formatActivityTimestamp(
                item.timestamp,
                t,
                i18n.resolvedLanguage
              )}
            />
          </span>
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-text-4 transition-transform group-open:rotate-90"
          />
        </summary>
        <ol
          className="m-0 mt-2 flex list-none flex-col gap-1.5 border-t border-border-1 pt-2"
          data-testid="work-item-activity-change-group-details"
        >
          {item.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex min-w-0 items-start justify-between gap-3 pl-1 text-text-3"
            >
              <span className="min-w-0 break-words">
                {entry.descriptions.join("; ")}
              </span>
              <span className="shrink-0">
                <ActivityTimestamp
                  timestamp={entry.timestamp}
                  label={formatActivityTimestamp(
                    entry.timestamp,
                    t,
                    i18n.resolvedLanguage
                  )}
                />
              </span>
            </li>
          ))}
        </ol>
      </details>
    </TimelineEventCard>
  );
}

function formatActivityTimestamp(
  timestamp: string,
  t: TFunction,
  language: string | undefined
): string {
  return formatSmartDateTime(timestamp, {
    yesterdayLabel: t("common:relativeDate.yesterday", {
      defaultValue: "Yesterday",
    }),
    locale: toIntlLocaleTag(language),
  });
}

function EntryDescriptions({
  entry,
}: {
  entry: TimelineEntry;
}): React.ReactNode {
  const { t } = useTranslation("projects");

  if (entry.descriptions.length === 1) {
    return <span>{entry.descriptions[0]}</span>;
  }

  return (
    <details className="mt-0.5">
      <summary className="inline cursor-pointer marker:text-text-4 hover:text-text-1">
        {t("workItems.activity.editedFields", {
          count: entry.descriptions.length,
        })}
      </summary>
      <ul className="m-0 mt-1 list-disc pl-4">
        {entry.descriptions.map((description, descriptionIndex) => (
          <li key={`${entry.id}-${descriptionIndex}`}>{description}</li>
        ))}
      </ul>
    </details>
  );
}
