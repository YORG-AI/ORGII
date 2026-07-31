import {
  CheckCircle2,
  ChevronUp,
  Circle,
  CircleHelp,
  MoreHorizontal,
} from "lucide-react";
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
import ProgressBar from "@src/components/ProgressBar";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { useDropdownEngine } from "@src/hooks/dropdown";
import {
  OrganizationStepIcon,
  ReadyStepIcon,
  TutorialStepIcon,
  WorkModelStepIcon,
} from "@src/modules/SetupWalkthrough/components/SetupStepIcons";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import type { WizardStepIcon } from "@src/scaffold/WizardSystem/primitives/WizardStepNavigation";

import {
  SIDEBAR_GUIDE_MILESTONE,
  type SidebarGuideCompletion,
  type SidebarGuideMilestone,
  getSidebarGuideProgress,
} from "./sidebarGuideProgress";

interface SidebarGuideButtonProps {
  completion: SidebarGuideCompletion;
  scopeLabel: string;
  onStartSession: () => void;
  onSetUpTeam: () => void;
  onManageWork: () => void;
  onOpenTutorials: () => void;
  onOpenQuickSetup: () => void;
}

interface GuideTaskRowProps {
  completed: boolean;
  current: boolean;
  icon: WizardStepIcon;
  label: string;
  testId: string;
  onClick: () => void;
}

const GuideTaskRow: FC<GuideTaskRowProps> = ({
  completed,
  current,
  icon: TaskIcon,
  label,
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
    suffix={<TaskIcon size={DROPDOWN_ITEM.iconSize} />}
    highlighted={current}
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
  scopeLabel,
  onStartSession,
  onSetUpTeam,
  onManageWork,
  onOpenTutorials,
  onOpenQuickSetup,
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
    placement: "bottom",
    align: "left",
    gap: DROPDOWN_PANEL.triggerGap,
    captureKeyboardFocus: true,
  });
  const progress = useMemo(
    () => getSidebarGuideProgress(completion),
    [completion]
  );
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
    icon: WizardStepIcon;
    label: string;
    testId: string;
    action: () => void;
  }[] = [
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.SESSION,
      icon: ReadyStepIcon,
      label: t("sidebar.guide.startSession"),
      testId: "sidebar-guide-task-session",
      action: onStartSession,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.TEAM,
      icon: OrganizationStepIcon,
      label: t("sidebar.guide.setUpTeam"),
      testId: "sidebar-guide-task-team",
      action: onSetUpTeam,
    },
    {
      milestone: SIDEBAR_GUIDE_MILESTONE.WORK,
      icon: WorkModelStepIcon,
      label: t("sidebar.guide.manageWork"),
      testId: "sidebar-guide-task-work",
      action: onManageWork,
    },
  ];

  return (
    <>
      <WorkstationToolbarTooltip
        label={t("sidebar.guide.trigger")}
        position="bottom"
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
            onClick={toggle}
          >
            <CircleHelp size={HEADER_ICON_SIZE.md} />
          </IconButton>
        </div>
      </WorkstationToolbarTooltip>

      {isOpen &&
        isPositioned &&
        createPortal(
          <DropdownPanel
            ref={panelRef}
            className={`${DROPDOWN_WIDTHS.fileTreeClass} fixed overflow-hidden !p-0`}
            maxHeight="none"
            role="menu"
            aria-label={t("sidebar.guide.title")}
            data-testid="sidebar-guide-panel"
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
            }}
          >
            <div className="border-0 border-b border-solid border-border-2 px-3 pb-2 pt-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-1">
                  {t("sidebar.guide.title")}
                </span>
                <WorkstationToolbarTooltip
                  label={t("sidebar.guide.quickSetup")}
                  position="top"
                >
                  <IconButton
                    aria-label={t("sidebar.guide.quickSetup")}
                    size="sm"
                    variant="default"
                    onClick={() => runAction(onOpenQuickSetup)}
                  >
                    <MoreHorizontal size={HEADER_ICON_SIZE.sm} />
                  </IconButton>
                </WorkstationToolbarTooltip>
                <IconButton
                  aria-label={t("sidebar.guide.close")}
                  size="sm"
                  variant="default"
                  onClick={close}
                >
                  <ChevronUp size={HEADER_ICON_SIZE.sm} />
                </IconButton>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <ProgressBar
                  percent={progress.percent}
                  height="h-1"
                  ariaLabel={t("sidebar.guide.progressLabel", {
                    completed: progress.completedCount,
                    total: progress.totalCount,
                  })}
                />
                <span className="shrink-0 text-xs tabular-nums text-text-3">
                  {progress.completedCount}/{progress.totalCount}
                </span>
              </div>
            </div>

            <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
              {milestoneRows.map((task) => (
                <GuideTaskRow
                  key={task.milestone}
                  completed={completion[task.milestone]}
                  current={progress.nextMilestone === task.milestone}
                  icon={task.icon}
                  label={task.label}
                  testId={task.testId}
                  onClick={() => runAction(task.action)}
                />
              ))}
              <div className={DROPDOWN_CLASSES.menuSeparator} />
              <DropdownItem
                icon={<Circle size={DROPDOWN_ITEM.iconSize} />}
                suffix={<TutorialStepIcon size={DROPDOWN_ITEM.iconSize} />}
                role="menuitem"
                tabIndex={0}
                fullWidth
                dataTestId="sidebar-guide-task-tutorials"
                onClick={() => runAction(onOpenTutorials)}
              >
                {t("sidebar.guide.openTutorials")}
              </DropdownItem>
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
