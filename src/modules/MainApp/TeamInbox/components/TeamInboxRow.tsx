import { AtSign, ClipboardList } from "lucide-react";
import { forwardRef, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getListItemClasses } from "@src/components/ListPanel";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  type TeamInboxItem,
  humanizeToken,
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
    const title = isMention ? item.target.sessionTitle : item.payload.title;
    const { meta, summary } = useMemo(() => {
      if (item.kind === "comment_mention") {
        return {
          meta: item.actor.displayName,
          summary: toCompactPreview(item.payload.commentBody),
        };
      }
      const status = t(workItemStatusLabelKey(item.payload.status), {
        defaultValue: humanizeToken(item.payload.status),
      });
      const priority = t(workItemPriorityLabelKey(item.payload.priority), {
        defaultValue: humanizeToken(item.payload.priority),
      });
      return {
        meta: `${status} · ${priority}`,
        summary: item.payload.summary
          ? toCompactPreview(item.payload.summary)
          : "",
      };
    }, [item, t]);
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
        aria-label={t("teamInbox.row.ariaLabel", {
          title,
          status: readLabel,
        })}
        tabIndex={selected ? 0 : -1}
        data-testid="team-inbox-row"
        data-item-kind={item.kind}
        data-item-id={item.id}
        data-unread={unread}
        className={`${getListItemClasses(selected)} w-full min-w-0 !items-start text-left`}
        onClick={() => onSelect(item)}
      >
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${isMention ? "bg-primary-1 text-primary-6" : "bg-success-1 text-success-6"}`}
          aria-hidden
        >
          {isMention ? <AtSign size={14} /> : <ClipboardList size={14} />}
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
          {summary ? (
            <span
              className="mt-0.5 line-clamp-2 block max-h-10 overflow-hidden text-xs font-normal leading-5 text-text-1"
              title={summary}
            >
              {summary}
            </span>
          ) : null}
          <span className="mt-1 block truncate text-xs font-normal text-text-4">
            {meta}
          </span>
        </span>
      </button>
    );
  }
);

TeamInboxRow.displayName = "TeamInboxRow";

export default TeamInboxRow;
