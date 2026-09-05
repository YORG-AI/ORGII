import React, { Children, forwardRef, useId, useState } from "react";

import Button from "@src/components/Button";
import { PILL_CONTROL_IDLE_SURFACE_CLASS } from "@src/components/CompoundPill/config";
import { ArrowUp01Icon, EllipsisIcon, HugeiconsIcon } from "@src/icons";

export type LaunchpadActionTone = "primary" | "neutral" | "success" | "warning";
export type LaunchpadActionPresentation = "card" | "pill";

export interface LaunchpadAction {
  id: string;
  title: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  tone: LaunchpadActionTone;
}

const ACTION_TONE_CLASS: Record<LaunchpadActionTone, string> = {
  primary:
    "border-primary-6/20 bg-primary-6/5 hover:border-primary-6/30 hover:bg-primary-6/10",
  neutral: `border-border-2 hover:border-border-3 ${PILL_CONTROL_IDLE_SURFACE_CLASS}`,
  success:
    "border-success-6/20 bg-success-6/5 hover:border-success-6/30 hover:bg-success-6/10",
  warning:
    "border-warning-6/20 bg-warning-6/5 hover:border-warning-6/30 hover:bg-warning-6/10",
};

const ACTION_CARD_TONE_CLASS: Record<LaunchpadActionTone, string> = {
  primary:
    "border-primary-6/20 hover:border-primary-6/30 hover:bg-surface-hover",
  neutral: "border-border-2 hover:border-border-3 hover:bg-surface-hover",
  success:
    "border-success-6/20 hover:border-success-6/30 hover:bg-surface-hover",
  warning:
    "border-warning-6/20 hover:border-warning-6/30 hover:bg-surface-hover",
};

const ACTION_ICON_TONE_CLASS: Record<LaunchpadActionTone, string> = {
  primary: "text-primary-6",
  neutral: "text-text-2",
  success: "text-success-6",
  warning: "text-warning-6",
};

interface LaunchpadActionCardProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> {
  "data-testid"?: string;
  action: LaunchpadAction;
  presentation?: LaunchpadActionPresentation;
}

export const LaunchpadActionCard = forwardRef<
  HTMLButtonElement,
  LaunchpadActionCardProps
>(function LaunchpadActionCard(
  { action, presentation = "pill", "data-testid": dataTestId, ...buttonProps },
  ref
) {
  if (presentation === "card") {
    return (
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        className={`group flex min-h-[68px] w-full flex-col items-start justify-between rounded-lg border bg-transparent px-2.5 py-2 text-left shadow-xs transition-colors focus-visible:border-primary-6 focus-visible:outline-none ${ACTION_CARD_TONE_CLASS[action.tone]}`}
        onClick={action.onClick}
        data-testid={dataTestId ?? `chat-panel-start-page-${action.id}`}
      >
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center ${ACTION_ICON_TONE_CLASS[action.tone]}`}
        >
          {action.icon}
        </span>
        <span className="block text-[12px] leading-4 font-medium text-text-1">
          {action.title}
        </span>
      </button>
    );
  }

  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      className={`group inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-left transition-colors focus-visible:border-primary-6 focus-visible:outline-none ${ACTION_TONE_CLASS[action.tone]}`}
      onClick={action.onClick}
      data-testid={dataTestId ?? `chat-panel-start-page-${action.id}`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${ACTION_ICON_TONE_CLASS[action.tone]}`}
      >
        {action.icon}
      </span>
      <span className="block min-w-0 truncate text-[12px] font-medium text-text-1">
        {action.title}
      </span>
    </button>
  );
});

interface LaunchpadActionGridToggleProps {
  collapsed: boolean;
  collapseLabel: string;
  controls: string;
  expandLabel: string;
  onClick: () => void;
  testId: string;
}

function LaunchpadActionGridToggle({
  collapsed,
  collapseLabel,
  controls,
  expandLabel,
  onClick,
  testId,
}: LaunchpadActionGridToggleProps): React.ReactNode {
  return (
    <Button
      variant="tertiary"
      size="mini"
      shape="circle"
      icon={
        <HugeiconsIcon
          icon={collapsed ? EllipsisIcon : ArrowUp01Icon}
          data-icon={collapsed ? "ellipsis" : "chevron-up"}
          size={14}
          strokeWidth={1.8}
        />
      }
      iconOnly
      aria-label={collapsed ? expandLabel : collapseLabel}
      aria-controls={controls}
      aria-expanded={!collapsed}
      onClick={onClick}
      data-testid={testId}
    />
  );
}

interface LaunchpadActionGridProps {
  cardWidthClassName?: string;
  children?: React.ReactNode;
  className?: string;
  collapseLabel?: string;
  collapsible?: boolean;
  controlAlignment?: "left" | "center";
  expandLabel?: string;
  header?: React.ReactNode;
  layoutActionCount?: number;
  presentation?: LaunchpadActionPresentation;
}

export function LaunchpadActionGrid({
  cardWidthClassName,
  children,
  className = "",
  collapseLabel = "Collapse",
  collapsible = false,
  controlAlignment = "left",
  expandLabel = "Expand",
  header,
  layoutActionCount,
  presentation = "pill",
}: LaunchpadActionGridProps): React.ReactNode {
  const [isStandardCollapsed, setIsStandardCollapsed] = useState(false);
  const [isCompactExpanded, setIsCompactExpanded] = useState(false);
  const contentId = useId();
  const isCardGrid = presentation === "card";
  const isCollapsibleCardGrid = collapsible && isCardGrid;
  const isCardGridCollapsed = isCollapsibleCardGrid && isStandardCollapsed;
  const expandControlAlignmentClass =
    controlAlignment === "center" ? "justify-center" : "justify-start pl-2.5";
  const collapseControlAlignmentClass =
    controlAlignment === "center" ? "left-1/2 -translate-x-1/2" : "left-2.5";
  const actionCount = layoutActionCount ?? Children.count(children);
  const cardWidthClass =
    cardWidthClassName ??
    (actionCount >= 4
      ? "max-w-[600px]"
      : actionCount === 3
        ? "max-w-[480px]"
        : "max-w-[320px]");
  const cardColumnClass =
    actionCount >= 4
      ? "@[560px]/startactions:grid-cols-4"
      : actionCount === 3
        ? "@[440px]/startactions:grid-cols-3"
        : "";
  const cardGridClass = isCardGrid
    ? `${
        isCollapsibleCardGrid ? "" : "hidden @[640px]/focusedchat:block"
      } ${cardWidthClass}`
    : "";

  const handleCompactToggle = () => {
    setIsStandardCollapsed(false);
    setIsCompactExpanded((expanded) => !expanded);
  };

  const handleStandardCollapse = () => {
    setIsCompactExpanded(false);
    setIsStandardCollapsed(true);
  };

  return (
    <div
      className={`group/launchpad-actions @container/startactions relative ${
        isCollapsibleCardGrid ? "launchpad-action-grid-compact" : ""
      } ${cardGridClass} ${className}`}
      data-compact-expanded={
        isCollapsibleCardGrid ? String(isCompactExpanded) : undefined
      }
    >
      {header || isCollapsibleCardGrid ? (
        <div
          className={`launchpad-action-grid-header mx-auto flex w-fit max-w-full flex-col items-start gap-0.5 ${
            header ? "mb-2" : ""
          }`}
        >
          {header}
          {isCollapsibleCardGrid ? (
            <div className="launchpad-action-grid-compact-toggle ml-1.5 shrink-0">
              <LaunchpadActionGridToggle
                collapsed={!isCompactExpanded}
                collapseLabel={collapseLabel}
                controls={contentId}
                expandLabel={expandLabel}
                onClick={handleCompactToggle}
                testId="launchpad-action-grid-compact-toggle"
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <div
        id={contentId}
        hidden={isCardGridCollapsed}
        className={`launchpad-action-grid-content ${
          isCardGridCollapsed
            ? "hidden"
            : isCardGrid
              ? `grid grid-cols-1 gap-2 @[300px]/startactions:grid-cols-2 ${cardColumnClass}`
              : "flex flex-wrap justify-center gap-2"
        }`}
      >
        {children}
      </div>
      {isCollapsibleCardGrid ? (
        isCardGridCollapsed ? (
          <div
            className={`flex w-full ${expandControlAlignmentClass}`}
            data-launchpad-action-grid-standard-control
            data-testid="launchpad-action-grid-expand-zone"
          >
            <LaunchpadActionGridToggle
              collapsed
              collapseLabel={collapseLabel}
              controls={contentId}
              expandLabel={expandLabel}
              onClick={() => setIsStandardCollapsed(false)}
              testId="launchpad-action-grid-expand"
            />
          </div>
        ) : (
          <div
            className={`absolute top-full z-10 pt-1 opacity-0 transition-opacity group-focus-within/launchpad-actions:opacity-100 group-hover/launchpad-actions:opacity-100 ${collapseControlAlignmentClass}`}
            data-launchpad-action-grid-standard-control
            data-testid="launchpad-action-grid-collapse-zone"
          >
            <LaunchpadActionGridToggle
              collapsed={false}
              collapseLabel={collapseLabel}
              controls={contentId}
              expandLabel={expandLabel}
              onClick={handleStandardCollapse}
              testId="launchpad-action-grid-collapse"
            />
          </div>
        )
      ) : null}
    </div>
  );
}
