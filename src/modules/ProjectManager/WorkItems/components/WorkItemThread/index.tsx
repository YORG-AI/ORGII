import React, { useId, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useElementDimensions } from "@src/hooks/ui/layout/useElementDimensions";
import {
  DetailPanelContainer,
  ScrollTrail,
} from "@src/modules/shared/layouts/blocks";

import { resolveWorkItemThreadHeaderPolicy } from "./presentation";
import { WORK_ITEM_THREAD_TOKENS } from "./tokens";

interface WorkItemThreadLayoutProps {
  path?: React.ReactNode;
  properties?: React.ReactNode;
  children: React.ReactNode;
  floatingFooter?: React.ReactNode;
}

export const WorkItemThreadLayout: React.FC<WorkItemThreadLayoutProps> = ({
  path,
  properties,
  children,
  floatingFooter,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const floatingFooterRef = useRef<HTMLDivElement>(null);
  const measuredFooterHeight = useElementDimensions(floatingFooterRef, {
    dimension: "height",
    enabled: Boolean(floatingFooter),
  });
  const footerBottomInset = floatingFooter
    ? Math.max(240, measuredFooterHeight)
    : undefined;
  const headerPolicy = resolveWorkItemThreadHeaderPolicy(
    Boolean(path),
    Boolean(properties)
  );

  return (
    <DetailPanelContainer>
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollContainerRef}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-hide @container"
          data-testid="work-item-thread-section"
        >
          <div
            ref={contentRef}
            className={WORK_ITEM_THREAD_TOKENS.contentColumn}
            style={{ paddingBottom: footerBottomInset }}
          >
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
        {floatingFooter ? (
          <div
            ref={floatingFooterRef}
            className="absolute bottom-0 left-0 right-11 z-50 flex flex-col items-center px-2 pb-2 pt-1"
            data-testid="work-item-thread-floating-footer"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 top-[-28px] bg-gradient-to-t from-chat-pane via-chat-pane/90 to-transparent"
            />
            <div className="relative z-10 w-full max-w-[920px] px-3">
              {floatingFooter}
            </div>
          </div>
        ) : null}
        <div
          className="relative w-11 shrink-0"
          data-testid="work-item-thread-navigation-rail"
        >
          <ScrollTrail
            scrollContainerRef={scrollContainerRef}
            contentRef={contentRef}
            ariaLabel={t("projects:workItems.navigationTrail", {
              defaultValue: "Work item navigation",
            })}
            placement="rail"
            testId="work-item-thread-navigation-trail"
          />
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
export {
  WorkItemThreadViewAction,
  type WorkItemThreadView,
} from "./WorkItemThreadViewAction";
