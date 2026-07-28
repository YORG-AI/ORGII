/** Shared activity timeline primitives used by work items, work logs, issues, and PRs. */
import { Check, Clipboard } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { useCopyCheck } from "@src/hooks/ui";
import { copyText } from "@src/util/data/clipboard";
import { formatDate } from "@src/util/data/formatters/date";

export {
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  normalizeMarkdownContent,
} from "@src/modules/shared/components/MarkdownContent";

export function TimelineCopyButton({
  body,
}: {
  body: string;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const onCopyContent = useCallback(async () => {
    await copyText(body);
  }, [body]);
  const { copied, handleCopy } = useCopyCheck(onCopyContent);

  if (!body.trim()) return null;

  return (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      iconOnly
      icon={
        copied ? (
          <Check size={12} strokeWidth={1.75} />
        ) : (
          <Clipboard size={12} strokeWidth={1.75} />
        )
      }
      title={copied ? t("status.copied") : t("actions.copy")}
      aria-label={copied ? t("status.copied") : t("actions.copy")}
      className="shrink-0 text-text-3 hover:bg-fill-2 hover:text-text-1"
      onClick={(event) => {
        event.stopPropagation();
        handleCopy();
      }}
    />
  );
}

/** Exact, timezone-aware activity timestamp. */
export function ActivityTimestamp({
  timestamp,
}: {
  timestamp: string;
}): React.ReactNode {
  const label = formatDate(timestamp);
  return (
    <time dateTime={timestamp} title={timestamp} className="whitespace-nowrap">
      {label}
    </time>
  );
}

/** Consistent actor/action/timestamp header used by full activity cards. */
export function TimelineCardHeader({
  avatar,
  indicator,
  actor,
  action,
  timestamp,
}: {
  avatar?: React.ReactNode;
  indicator?: React.ReactNode;
  actor: React.ReactNode;
  action: React.ReactNode;
  timestamp?: string | null;
}): React.ReactNode {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {avatar}
      {indicator}
      <span className="min-w-0 truncate text-[12px] text-text-3">
        <span className="font-medium text-text-1">{actor}</span> {action}
        {timestamp ? (
          <>
            {" "}
            <ActivityTimestamp timestamp={timestamp} />
          </>
        ) : null}
      </span>
    </span>
  );
}

/** Shared vertical stack for full cards and compact activity rows. */
export function TimelineStack({
  children,
}: {
  children: React.ReactNode;
}): React.ReactNode {
  return <div className="flex min-w-0 flex-col">{children}</div>;
}

/** A timeline entry with an optional connecting rail to the next item. */
export function ConnectedTimelineItem({
  children,
  isLast,
}: {
  children: React.ReactNode;
  isLast?: boolean;
}): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-col">
      {children}
      {!isLast ? (
        <div className="-mt-px ml-5 h-3 border-l border-border-1" aria-hidden />
      ) : null}
    </div>
  );
}

/** A bordered timeline card: header row (+ optional copy button) over a body. */
export function TimelineCard({
  header,
  copyBody,
  footer,
  children,
}: {
  header: React.ReactNode;
  copyBody?: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-1 bg-primary-container">
      <div className="flex min-w-0 select-text items-center justify-between gap-3 border-b border-border-1 px-3 py-2">
        {header}
        {copyBody ? <TimelineCopyButton body={copyBody} /> : null}
      </div>
      <div className="min-w-0 select-text px-3 py-3">{children}</div>
      {footer}
    </div>
  );
}

/** Compact bordered event row used between full timeline cards. */
export function TimelineEventCard({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-lg border border-border-1 bg-primary-container px-3 py-2 text-[12px] text-text-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fill-2 text-text-2">
        {icon}
      </span>
      <div className="min-w-0 flex-1 leading-5">{children}</div>
    </div>
  );
}
