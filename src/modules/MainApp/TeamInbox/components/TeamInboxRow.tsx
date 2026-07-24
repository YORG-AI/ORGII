import { AtSign, ClipboardList } from "lucide-react";
import { forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";

import IntegrationIcon from "@src/components/IntegrationIcon";
import { getListItemClasses } from "@src/components/ListPanel";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  type TeamInboxItem,
  humanizeToken,
  isGitHubIssueStatus,
  workItemPriorityLabelKey,
  workItemStatusLabelKey,
} from "../domain";

export interface TeamInboxRowProps {
  item: TeamInboxItem;
  itemKey: string;
  selected: boolean;
  onSelect: (item: TeamInboxItem) => void;
}

const TeamInboxRow = forwardRef<HTMLButtonElement, TeamInboxRowProps>(
  ({ item, itemKey, selected, onSelect }, ref) => {
    const { t } = useTranslation();
    const isMention = item.kind === "comment_mention";
    const isGitHubIssue =
      item.kind === "assigned_work_item" &&
      isGitHubIssueStatus(item.payload.status);
    const title = isMention ? item.target.sessionTitle : item.payload.title;
    const summary = useMemo(() => {
      if (item.kind === "comment_mention") return item.payload.commentBody;
      if (item.payload.summary) return item.payload.summary;
      const status = t(workItemStatusLabelKey(item.payload.status), {
        defaultValue: humanizeToken(item.payload.status),
      });
      const priority = t(workItemPriorityLabelKey(item.payload.priority), {
        defaultValue: humanizeToken(item.payload.priority),
      });
      return t("teamInbox.row.assignedSummary", { status, priority });
    }, [item, t]);
    const personName = isMention
      ? item.actor.displayName
      : (item.payload.assigneeName ?? item.payload.assigneeMemberId);
    const relativeTime = useMemo(
      () => formatRelativeTime(item.occurredAt, "nano"),
      [item.occurredAt]
    );
    const unread = item.readAt === null;
    const readLabel = t(
      unread ? "teamInbox.status.unread" : "teamInbox.status.read"
    );

    return (
      <button
        ref={ref}
        id={itemKey}
        type="button"
        role="option"
        aria-selected={selected}
        aria-label={`${title}，${readLabel}`}
        tabIndex={selected ? 0 : -1}
        data-unread={unread}
        className={`${getListItemClasses(selected)} w-full min-w-0 !items-start text-left`}
        onClick={() => onSelect(item)}
      >
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            isMention
              ? "bg-primary-1 text-primary-6"
              : isGitHubIssue
                ? "bg-fill-2 text-text-1"
                : "bg-success-1 text-success-6"
          }`}
          aria-hidden
        >
          {isMention ? (
            <AtSign size={14} />
          ) : isGitHubIssue ? (
            <IntegrationIcon type="github" size={14} />
          ) : (
            <ClipboardList size={14} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            {unread ? (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary-6"
                aria-hidden
              />
            ) : null}
            <span
              className={`truncate text-xs text-text-1 ${unread ? "font-semibold" : "font-medium"}`}
            >
              {title}
            </span>
            <span className="ml-auto shrink-0 text-xs font-normal text-text-4">
              {relativeTime}
            </span>
          </span>
          <span className="mt-0.5 line-clamp-2 text-xs font-normal leading-5 text-text-3">
            {summary}
          </span>
          <span className="mt-1 flex items-center gap-2 text-xs font-normal text-text-4">
            <span className="truncate">{personName}</span>
          </span>
        </span>
      </button>
    );
  }
);

TeamInboxRow.displayName = "TeamInboxRow";

export default TeamInboxRow;
