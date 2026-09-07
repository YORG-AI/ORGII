import { forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";

import IntegrationIcon from "@src/components/IntegrationIcon";
import { ListPanelItem } from "@src/components/ListPanel";
import {
  AlertCircleIcon,
  CircleCheckBigIcon,
  HugeiconsIcon,
  ListChecksIcon,
  MessageSquareMoreIcon,
  Notification01Icon,
} from "@src/icons";
import { compactRepositoryLabel } from "@src/modules/shared/githubRepositoryLabel";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  type TeamInboxItem,
  humanizeToken,
  isGitHubIssueStatus,
  parseGitHubIssueNumber,
  workItemEventLabelKey,
  workItemPriorityLabelKey,
  workItemStatusLabelKey,
} from "../domain";

export interface TeamInboxRowProps {
  item: TeamInboxItem;
  itemKey: string;
  selected: boolean;
  onSelect: (item: TeamInboxItem) => void;
}

function toCompactPreview(content: string): string {
  return content
    .replace(/\\[nr]/g, "\n")
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}[\t ]+/gm, "")
    .replace(/^\s{0,3}>[\t ]?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])[\t ]+/gm, "")
    .replace(/^\s*\[[ xX]\][\t ]+/gm, "")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const TeamInboxRow = forwardRef<HTMLButtonElement, TeamInboxRowProps>(
  ({ item, itemKey, selected, onSelect }, ref) => {
    const { t } = useTranslation();
    const isMention = item.kind === "comment_mention";
    const isAssigned = item.kind === "assigned_work_item";
    const isGitHubIssue =
      item.kind === "assigned_work_item" &&
      isGitHubIssueStatus(item.payload.status);
    const issueNumber =
      item.kind === "assigned_work_item" && isGitHubIssue
        ? parseGitHubIssueNumber(item.target.workItemId)
        : undefined;
    const title = isMention
      ? item.target.kind === "session_comment"
        ? item.target.sessionTitle
        : item.target.workItemTitle
      : item.payload.title;
    const { meta, summary } = useMemo(() => {
      if (item.kind === "comment_mention") {
        return {
          meta: item.actor.displayName,
          summary: toCompactPreview(item.payload.commentBody),
        };
      }
      const repository = compactRepositoryLabel(item.target.repository);
      const source = repository
        ? t("teamInbox.row.issueSource", { repository })
        : t("teamInbox.row.issueSourceFallback");
      if (!isAssigned) {
        return {
          meta: `${t(workItemEventLabelKey(item.payload.eventKind), {
            defaultValue: humanizeToken(item.payload.eventKind),
          })} · ${source}`,
          summary: toCompactPreview(item.payload.summary ?? ""),
        };
      }
      const handoff = item.payload.handoff;
      if (!handoff) {
        return {
          meta: `${t("teamInbox.filters.assigned")} · ${source}`,
          summary: "",
        };
      }
      const status = t(workItemStatusLabelKey(item.payload.status), {
        defaultValue: humanizeToken(item.payload.status),
      });
      const priority = t(workItemPriorityLabelKey(item.payload.priority), {
        defaultValue: humanizeToken(item.payload.priority),
      });
      const meta = t(
        handoff.status === "pending"
          ? "teamInbox.handoff.rowPending"
          : handoff.status === "accepted"
            ? "teamInbox.handoff.rowAccepted"
            : "teamInbox.handoff.rowReturned",
        {
          name:
            handoff.status === "returned"
              ? handoff.recipientName
              : handoff.senderName,
          status,
          priority,
        }
      );
      return {
        meta: `${meta} · ${source}`,
        summary: "",
      };
    }, [isAssigned, item, t]);
    const relativeTime = useMemo(
      () => formatRelativeTime(item.occurredAt, "nano"),
      [item.occurredAt]
    );
    const unread = item.readAt === null;
    const readLabel = t(
      unread ? "teamInbox.status.unread" : "teamInbox.status.read"
    );

    return (
      <ListPanelItem
        ref={ref}
        id={itemKey}
        selected={selected}
        role="option"
        ariaLabel={t("teamInbox.row.ariaLabel", {
          title: issueNumber === undefined ? title : `#${issueNumber} ${title}`,
          status: readLabel,
        })}
        tabIndex={selected ? 0 : -1}
        dataAttributes={{
          "data-team-inbox-list-item": true,
          "data-testid": "team-inbox-row",
          "data-item-kind": item.kind,
          "data-item-id": item.id,
          "data-unread": unread,
        }}
        title={title}
        titlePrefix={issueNumber === undefined ? undefined : `#${issueNumber}`}
        time={relativeTime}
        preview={summary}
        metadata={<span className="truncate">{meta}</span>}
        unread={unread}
        leading={
          isMention ? (
            <HugeiconsIcon
              icon={MessageSquareMoreIcon}
              data-icon="message-square-more"
              size={14}
              strokeWidth={1.8}
            />
          ) : item.kind === "work_item_run_failed" ? (
            <HugeiconsIcon
              icon={AlertCircleIcon}
              data-icon="circle-alert"
              size={14}
              strokeWidth={1.8}
            />
          ) : item.kind === "child_completed" ? (
            <HugeiconsIcon
              icon={CircleCheckBigIcon}
              data-icon="circle-check-big"
              size={14}
              strokeWidth={1.8}
            />
          ) : item.kind === "work_item_updated" ? (
            <HugeiconsIcon
              icon={Notification01Icon}
              data-icon="bell-ring"
              size={14}
              strokeWidth={1.8}
            />
          ) : isGitHubIssue ? (
            <IntegrationIcon type="github" size={14} />
          ) : (
            <HugeiconsIcon
              icon={ListChecksIcon}
              data-icon="list-checks"
              size={14}
              strokeWidth={1.8}
            />
          )
        }
        leadingClassName={
          isMention
            ? "text-primary-6"
            : item.kind === "work_item_run_failed"
              ? "text-danger-6"
              : item.kind === "child_completed"
                ? "text-success-6"
                : item.kind === "work_item_updated"
                  ? "text-warning-6"
                  : isGitHubIssue
                    ? "text-text-2"
                    : "text-success-6"
        }
        onClick={() => onSelect(item)}
      />
    );
  }
);

TeamInboxRow.displayName = "TeamInboxRow";

export default TeamInboxRow;
