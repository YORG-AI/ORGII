import React, { useId } from "react";

import { DetailPanelContainer } from "@src/modules/shared/layouts/blocks";

import { resolveWorkItemThreadHeaderPolicy } from "./presentation";
import { WORK_ITEM_THREAD_TOKENS } from "./tokens";

interface WorkItemThreadLayoutProps {
  path?: React.ReactNode;
  properties?: React.ReactNode;
  children: React.ReactNode;
}

export const WorkItemThreadLayout: React.FC<WorkItemThreadLayoutProps> = ({
  path,
  properties,
  children,
}) => {
  const headerPolicy = resolveWorkItemThreadHeaderPolicy(
    Boolean(path),
    Boolean(properties)
  );

  return (
    <DetailPanelContainer className="relative">
      <div
        className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto @container"
        data-testid="work-item-thread-section"
      >
        <div className={WORK_ITEM_THREAD_TOKENS.contentColumn}>
          {headerPolicy.showHeader ? (
            <div className={WORK_ITEM_THREAD_TOKENS.metadataBand}>
              {path ? <div className="shrink-0">{path}</div> : null}
              {headerPolicy.showSeparator ? (
                <div
                  className="h-5 shrink-0 border-l border-border-2"
                  aria-hidden
                />
              ) : null}
              {properties ? (
                <div className="min-w-0 flex-1">{properties}</div>
              ) : null}
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </DetailPanelContainer>
  );
};

interface WorkItemThreadSectionProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  testId?: string;
  bodyClassName?: string;
}

export const WorkItemThreadSection: React.FC<WorkItemThreadSectionProps> = ({
  icon,
  title,
  meta,
  action,
  children,
  testId,
  bodyClassName,
}) => {
  const titleId = useId();

  return (
    <section
      className={WORK_ITEM_THREAD_TOKENS.card}
      data-testid={testId}
      aria-labelledby={titleId}
    >
      <div className={WORK_ITEM_THREAD_TOKENS.cardHeader}>
        <div className="flex min-w-0 items-center gap-2">
          {icon}
          <span id={titleId} className="text-[13px] font-semibold text-text-1">
            {title}
          </span>
          {meta}
        </div>
        {action}
      </div>
      <div
        className={
          bodyClassName
            ? `${WORK_ITEM_THREAD_TOKENS.cardBody} ${bodyClassName}`
            : WORK_ITEM_THREAD_TOKENS.cardBody
        }
      >
        {children}
      </div>
    </section>
  );
};

export { WORK_ITEM_THREAD_TOKENS } from "./tokens";
