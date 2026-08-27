import { CheckCircle2, ChevronDown, Circle, Rocket, X } from "lucide-react";
import React, { type FC, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IconButton from "@src/components/IconButton";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";

import {
  SIDEBAR_GUIDE_MILESTONE,
  type SidebarGuideCompletion,
  type SidebarGuideMilestone,
  getNextSidebarGuideMilestone,
} from "./sidebarGuideProgress";

interface SidebarGuideButtonProps {
  completion: SidebarGuideCompletion;
  dismissed: boolean;
  scopeLabel: string;
  onDismiss: () => void;
  onStartSession: () => void;
  onConnectOrganization: () => void;
  onInviteTeammate: () => void;
  onViewTeamUsage: () => void;
  onExploreProduct: () => void;
}

interface GuideTaskRowProps {
  completed: boolean;
  current: boolean;
  label: string;
  nextStepLabel: string;
  testId: string;
  onClick: () => void;
}

const GuideTaskRow: FC<GuideTaskRowProps> = ({
  completed,
  current,
  label,
  nextStepLabel,
  testId,
  onClick,
}) => (
  <DropdownItem
    icon={
      completed ? (
        <CheckCircle2
          size={DROPDOWN_ITEM.iconSize}
          className="text-success-6"
        />
      ) : (
        <Circle size={DROPDOWN_ITEM.iconSize} />
      )
    }
    suffix={
      current ? (
        <span className="rounded-full bg-primary-1 px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-6">
          {nextStepLabel}
        </span>
      ) : undefined
    }
    className={current ? "bg-primary-6/5" : undefined}
    role="menuitem"
    tabIndex={0}
    fullWidth
    dataTestId={testId}
    onClick={onClick}
  >
    {label}
  </DropdownItem>
);

/**
 * Persistent entry point for optional product guidance.
 *
 * This component owns only the floating-panel lifecycle and derived progress
 * presentation. Product facts and navigation remain with existing stores and
 * the sidebar connector, so the panel never creates a second setup state.
 */
const SidebarGuideButton: FC<SidebarGuideButtonProps> = ({
  completion,
  dismissed,
  scopeLabel,
  onDismiss,
  onStartSession,
  onConnectOrganization,
  onInviteTeammate,
  onViewTeamUsage,
  onExploreProduct,
}) => {
  const { t } = useTranslation("navigation");
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLDivElement>({
    defaultOpen: false,
    placement: "top",
    align: "right",
    gap: DROPDOWN_PANEL.triggerGap,
    captureKeyboardFocus: true,
  });
  const nextMilestone = useMemo(
    () => getNextSidebarGuideMilestone(completion),
    [completion]
  );
  const guideCompleted = nextMilestone === null;
  const scopeInitial = scopeLabel.trim().charAt(0).toLocaleUpperCase();

  const runAction = useCallback(
    (action: () => void) => {
      close();
      action();
    },
    [close]
  );

  const milestoneRows: readonly {
    milestone: SidebarGuideMilestone;
    label: string;
    testId: string;
    action: () => void;
  }[] = [
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.SESSION,
      label: t("sidebar.guide.startSession"),
      testId: "sidebar-guide-task-session",
      action: onStartSession,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.ORGANIZATION,
      label: t("sidebar.guide.connectOrganization"),
      testId: "sidebar-guide-task-organization",
      action: onConnectOrganization,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.TEAMMATE,
      label: t("sidebar.guide.inviteTeammate"),
      testId: "sidebar-guide-task-teammate",
      action: onInviteTeammate,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE,
      label: t("sidebar.guide.viewTeamActivity"),
      testId: "sidebar-guide-task-team-usage",
      action: onViewTeamUsage,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR,
      label: t("sidebar.guide.exploreProduct"),
      testId: "sidebar-guide-task-product-tour",
      action: onExploreProduct,
    },
  ];

  if (dismissed || guideCompleted) return null;

  return (
    <>
      <ToolbarTooltip
        label={t("sidebar.guide.trigger")}
        position="top"
        disabled={isOpen}
      >
        <div ref={triggerRef} className="inline-flex">
          <IconButton
            aria-label={t("sidebar.guide.trigger")}
            aria-haspopup="menu"
            aria-expanded={isOpen}
            data-testid="sidebar-guide-trigger"
            size="lg"
            variant={isOpen ? "active" : "default"}
            className={`rounded-full ${isOpen ? "" : "!text-text-2"}`}
            onClick={toggle}
          >
            <Rocket size={HEADER_ICON_SIZE.md} strokeWidth={2} />
          </IconButton>
        </div>
      </ToolbarTooltip>

      {isOpen &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className={`${DROPDOWN_WIDTHS.fileTreeClass} fixed overflow-hidden !p-0`}
            maxHeight="none"
            role="menu"
            aria-label={t("sidebar.guide.title")}
            aria-hidden={!isPositioned}
            data-testid="sidebar-guide-panel"
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left:
                panelPosition.right === undefined
                  ? panelPosition.left
                  : undefined,
              right: panelPosition.right,
              visibility: isPositioned ? undefined : "hidden",
              pointerEvents: isPositioned ? undefined : "none",
            }}
          >
            <div className="border-0 border-b border-solid border-border-2 px-3 pb-2 pt-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-1">
                  {t("sidebar.guide.title")}
                </span>
                <IconButton
                  aria-label={t("sidebar.guide.dismiss")}
                  size="sm"
                  variant="default"
                  onClick={() => runAction(onDismiss)}
                >
                  <X size={HEADER_ICON_SIZE.sm} />
                </IconButton>
                <IconButton
                  aria-label={t("sidebar.guide.close")}
                  size="sm"
                  variant="default"
                  onClick={close}
                >
                  <ChevronDown size={HEADER_ICON_SIZE.sm} />
                </IconButton>
              </div>
            </div>

            <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
              {milestoneRows.map((task) => (
                <GuideTaskRow
                  key={task.milestone}
                  completed={completion[task.milestone]}
                  current={nextMilestone === task.milestone}
                  label={task.label}
                  nextStepLabel={t("sidebar.guide.nextStep")}
                  testId={task.testId}
                  onClick={() => runAction(task.action)}
                />
              ))}
            </div>

            <div className="flex items-center gap-2 border-0 border-t border-solid border-border-2 px-3 py-2">
              <Avatar
                size={
                  DROPDOWN_ITEM.height -
                  DROPDOWN_ITEM.gap -
                  DROPDOWN_PANEL.padding
                }
              >
                {scopeInitial || "O"}
              </Avatar>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-2">
                {scopeLabel}
              </span>
            </div>
          </DropdownPanel>,
          document.body
        )}
    </>
  );
};

export default SidebarGuideButton;
