import React from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssueTimelineItem } from "@src/api/tauri/github";
import { projectMarkdownSessionReferences } from "@src/components/MarkDown/sessionReferenceProjection";
import PersonAvatar from "@src/components/PersonAvatar";
import {
  ConnectedTimelineItem,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineLoadingSkeleton,
} from "@src/modules/shared/components/ActivityTimeline";

import { IssueTimelineEventRow } from "./IssueTimelineEvent";

interface IssueTimelineItemsProps {
  timeline: GitHubIssueTimelineItem[];
  timelineLoading: boolean;
  navigationEnabled?: boolean;
}

export function getIssueTimelineTrailLabel(
  item: GitHubIssueTimelineItem
): string {
  const actor = item.actor?.login ?? "GitHub";
  if (item.event === "commented" && item.body?.trim()) {
    return `${actor}: ${item.body}`;
  }
  return `${actor} · ${item.event.replace(/[_-]/g, " ")}`;
}

/**
 * Shared renderer for the GitHub activity that follows an issue description.
 * Keeping this separate from the issue shell lets every detail entry point use
 * the canonical Work Item thread without introducing a component cycle.
 */
export function IssueTimelineItems({
  timeline,
  timelineLoading,
  navigationEnabled = false,
}: IssueTimelineItemsProps): React.ReactNode {
  const { t } = useTranslation("common");

  if (timelineLoading) {
    return (
      <ConnectedTimelineItem
        isLast
        trailLabel={
          navigationEnabled
            ? t("git.issues.loadingTimeline", "Loading activity…")
            : undefined
        }
      >
        <TimelineLoadingSkeleton
          label={t("git.issues.loadingTimeline", "Loading activity…")}
        />
      </ConnectedTimelineItem>
    );
  }

  return timeline.map((item, index) => {
    const isLast = index === timeline.length - 1;
    const key = `${item.event}-${item.id ?? item.created_at ?? index}-${index}`;

    if (item.event !== "commented") {
      return (
        <ConnectedTimelineItem
          key={key}
          isLast={isLast}
          trailLabel={
            navigationEnabled ? getIssueTimelineTrailLabel(item) : undefined
          }
        >
          <IssueTimelineEventRow item={item} />
        </ConnectedTimelineItem>
      );
    }

    const body = item.body ?? "";
    const isSessionAttachment =
      projectMarkdownSessionReferences(body).referenceOnly;
    const actorName = item.actor?.login ?? "GitHub";
    return (
      <ConnectedTimelineItem
        key={key}
        isLast={isLast}
        trailLabel={
          navigationEnabled ? getIssueTimelineTrailLabel(item) : undefined
        }
      >
        <TimelineCard
          copyBody={body}
          header={
            <TimelineCardHeader
              avatar={
                item.actor ? (
                  <PersonAvatar
                    size={18}
                    name={actorName}
                    src={item.actor.avatar_url}
                  />
                ) : null
              }
              actor={actorName}
              action={
                isSessionAttachment
                  ? t(
                      "git.issues.activity.appendedSession",
                      "appended a session"
                    )
                  : t("git.issues.activity.commented", "commented")
              }
              timestamp={item.created_at}
            />
          }
        >
          <MarkdownContent body={body} fadeFrom="from-chat-pane" />
        </TimelineCard>
      </ConnectedTimelineItem>
    );
  });
}
