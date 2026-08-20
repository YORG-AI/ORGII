/** Shared activity timeline primitives used by work items, work logs, issues, and PRs. */
import { Check, Copy } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button, { type ButtonProps } from "@src/components/Button";
import { useCopyCheck } from "@src/hooks/ui";
import { normalizeScrollTrailLabel } from "@src/modules/shared/layouts/blocks/ScrollTrail";
import { copyText } from "@src/util/data/clipboard";
import {
  formatDate,
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

export {
  MARKDOWN_CONTENT_PREVIEW_MAX_HEIGHT,
  MarkdownContent,
  normalizeMarkdownContent,
} from "@src/modules/shared/components/MarkdownContent";

export interface ActivityHeaderActionButtonProps extends Omit<
  ButtonProps,
  | "variant"
  | "appearance"
  | "size"
  | "iconOnly"
  | "children"
  | "title"
  | "aria-label"
> {
  icon: React.ReactNode;
  label: string;
}

/** Canonical icon action for activity-card and thread-section headers. */
export function ActivityHeaderActionButton({
  icon,
  label,
  className = "",
  ...buttonProps
}: ActivityHeaderActionButtonProps): React.ReactNode {
  return (
    <Button
      variant="tertiary"
      appearance="ghost"
      size="mini"
      iconOnly
      icon={icon}
      title={label}
      aria-label={label}
      className={`shrink-0 select-none text-text-3 hover:bg-fill-2 hover:text-text-1 ${className}`.trim()}
      {...buttonProps}
    />
  );
}

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
    <ActivityHeaderActionButton
      icon={
        copied ? (
          <Check size={12} strokeWidth={1.75} />
        ) : (
          <Copy size={12} strokeWidth={1.75} />
        )
      }
      label={copied ? t("status.copied") : t("actions.copy")}
      data-testid="timeline-copy-button"
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
  label,
}: {
  timestamp: string;
  label?: string;
}): React.ReactNode {
  const { t, i18n } = useTranslation("common");
  const fullLabel = formatDate(timestamp);
  const displayLabel =
    label ??
    formatSmartDateTime(timestamp, {
      yesterdayLabel: t("relativeDate.yesterday", {
        defaultValue: "Yesterday",
      }),
      locale: toIntlLocaleTag(i18n?.resolvedLanguage),
    });
  return (
    <time dateTime={timestamp} title={fullLabel} className="whitespace-nowrap">
      {displayLabel}
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
  timestampLabel,
}: {
  avatar?: React.ReactNode;
  indicator?: React.ReactNode;
  actor: React.ReactNode;
  action: React.ReactNode;
  timestamp?: string | null;
  timestampLabel?: string;
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
            <ActivityTimestamp timestamp={timestamp} label={timestampLabel} />
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

/** Text-free loading frame that mirrors a full timeline card. */
export function TimelineLoadingSkeleton({
  label,
}: {
  label: string;
}): React.ReactNode {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="min-w-0 animate-pulse overflow-hidden rounded-xl border border-border-1 bg-chat-pane motion-reduce:animate-none"
      data-testid="timeline-loading-skeleton"
    >
      <div className="flex h-10 items-center gap-2 border-b border-border-1 bg-primary-container px-3">
        <span aria-hidden className="size-5 rounded-full bg-fill-2" />
        <span aria-hidden className="h-3 w-28 rounded bg-fill-2" />
        <span aria-hidden className="h-3 w-16 rounded bg-fill-2" />
      </div>
      <div className="space-y-2.5 px-3 py-3">
        <span aria-hidden className="block h-3 w-full rounded bg-fill-2" />
        <span aria-hidden className="block h-3 w-11/12 rounded bg-fill-2" />
        <span aria-hidden className="block h-3 w-2/3 rounded bg-fill-2" />
      </div>
    </div>
  );
}

/** A timeline entry with an optional connecting rail to the next item. */
export function ConnectedTimelineItem({
  children,
  isLast,
  trailLabel,
}: {
  children?: React.ReactNode;
  isLast?: boolean;
  trailLabel?: string;
}): React.ReactNode {
  return (
    <div
      className="relative flex min-w-0 flex-col"
      data-scroll-trail-target={trailLabel ? true : undefined}
      data-scroll-trail-label={
        trailLabel ? normalizeScrollTrailLabel(trailLabel) : undefined
      }
    >
      {!isLast ? (
        <div
          className="pointer-events-none absolute bottom-0 left-5 top-5 border-l border-border-1"
          data-testid="timeline-connector"
          aria-hidden
        />
      ) : null}
      <div className="relative z-10 min-w-0">{children}</div>
      {!isLast ? <div className="-mt-px h-3 shrink-0" aria-hidden /> : null}
    </div>
  );
}

/** A bordered timeline card: header row (+ optional copy button) over a body. */
export function TimelineCard({
  header,
  copyBody,
  actions,
  footer,
  children,
  className = "",
  bodyClassName = "",
}: {
  header: React.ReactNode;
  copyBody?: string;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}): React.ReactNode {
  return (
    <div
      className={`flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border-1 bg-chat-pane ${className}`.trim()}
    >
      <div className="allow-select-deep flex min-w-0 items-center justify-between gap-3 border-b border-border-1 bg-primary-container px-3 py-2">
        {header}
        {copyBody || actions ? (
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {copyBody ? <TimelineCopyButton body={copyBody} /> : null}
          </div>
        ) : null}
      </div>
      <div
        className={`allow-select-deep min-w-0 px-3 py-3 ${bodyClassName}`.trim()}
      >
        {children}
      </div>
      {footer}
    </div>
  );
}

/** Compact event row used between full timeline cards. */
export function TimelineEventCard({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children?: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.5 text-[11px] text-text-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fill-2 text-text-2">
        {icon}
      </span>
      <div className="min-w-0 flex-1 leading-4">{children}</div>
    </div>
  );
}
