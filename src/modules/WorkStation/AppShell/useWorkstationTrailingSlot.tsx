/**
 * useWorkstationTrailingSlot
 *
 * Builds the trailing-slot ReactNode for WorkstationTabBar.
 * Extracted to isolate the complex conditional rendering logic
 * (Plus menu, Chat Panel toggle, Minimize/Restore control,
 * Project trailing bar) from the
 * main tab-bar component.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type ReactNode, startTransition, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { TabBarTrailingIconButton } from "@src/components/TabPill/TabBarTrailingIconButton";
import {
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  HugeiconsIcon,
  LayoutAlignRightIcon,
  PanelRightIcon,
} from "@src/icons";
import ProjectManagerWorkItemsTabBarTrailing from "@src/modules/ProjectManager/ProjectManagerLayout/components/ProjectManagerWorkItemsTabBarTrailing";
import { TabBarPlusMenu } from "@src/modules/WorkStation/AppShell/TabBarPlusMenu";
import { HEADER_ICON_SIZE } from "@src/modules/WorkStation/shared/tokens";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import {
  activeStationChatVisibleAtom,
  chatWidthAtom,
  toggleChatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import { chatPanelPositionAtom } from "@src/store/ui/workStationAtom";
import type { ChatPanelPosition } from "@src/store/ui/workStationLayout/chatPositionAtoms";
import { workstationProjectTabBarAtom } from "@src/store/workstation";
import type { WorkstationTabHost } from "@src/store/workstation/tabHost";

import type { UseWorkstationTabListReturn } from "./useWorkstationTabList";

export interface UseWorkstationTrailingSlotOptions {
  host: WorkstationTabHost;
  visible: UseWorkstationTabListReturn["visible"];
}

export interface UseWorkstationTrailingSlotReturn {
  trailingSlot: ReactNode;
  handleToggleChatPanel: () => void;
}

export function WorkstationMaximizeChatIcon({
  chatPanelPosition,
}: {
  chatPanelPosition: ChatPanelPosition;
}): ReactNode {
  if (chatPanelPosition === "right") {
    return (
      <HugeiconsIcon
        icon={Cancel01Icon}
        data-icon="x"
        size={HEADER_ICON_SIZE.md}
        strokeWidth={1.75}
      />
    );
  }

  return (
    <span className="flex h-4 w-4 items-center justify-center">
      <HugeiconsIcon
        icon={PanelRightIcon}
        data-icon="panel-right"
        size={HEADER_ICON_SIZE.md}
        strokeWidth={2}
        className="group-hover:hidden"
      />
      <HugeiconsIcon
        icon={LayoutAlignRightIcon}
        data-icon="layout-align-right"
        size={HEADER_ICON_SIZE.md}
        strokeWidth={2}
        className="hidden group-hover:block"
      />
    </span>
  );
}

export function useWorkstationTrailingSlot({
  host,
  visible,
}: UseWorkstationTrailingSlotOptions): UseWorkstationTrailingSlotReturn {
  const { t } = useTranslation(["sessions", "common", "settings"]);
  const location = useLocation();
  const getStationChatVisible = useAtomValue(activeStationChatVisibleAtom);
  const chatWidth = useAtomValue(chatWidthAtom);
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const projectTabBar = useAtomValue(workstationProjectTabBarAtom);
  const toggleChatPanelMaximized = useSetAtom(toggleChatPanelMaximizedAtom);

  const isChatPanelVisible =
    getStationChatVisible("my-station") && chatWidth > 0;
  // Settings occupies the chat-panel slot; SettingsSlot owns its own
  // maximize/restore button, so the workstation-side toggle is redundant
  // and visually conflicting (two buttons driving the same atom).
  const isSettingsRoute = location.pathname.startsWith("/orgii/app/settings");

  const handleToggleChatPanel = useMemo(
    () => () => {
      startTransition(() => {
        void WorkStationViewService.showWorkStation();
      });
    },
    []
  );

  const handleToggleChatPanelMaximized = useMemo(
    () => () => {
      toggleChatPanelMaximized();
    },
    [toggleChatPanelMaximized]
  );

  const trailingSlot = useMemo((): ReactNode => {
    // Unified surface: the "+" (new-tab) menu always renders. There are no
    // per-app surfaces left to gate it on — from anywhere you can open any
    // tab type.
    const plusMenuControl = <TabBarPlusMenu />;

    const chatPanelLabel = isChatPanelVisible
      ? t("sessions:chat.maximizeWorkStation")
      : t("sessions:chat.restoreChatPanel");
    const chatPanelControl = isSettingsRoute ? null : (
      <TabBarTrailingIconButton
        title={chatPanelLabel}
        shortcutId="maximize_work_station"
        onClick={handleToggleChatPanel}
      >
        {isChatPanelVisible ? (
          <HugeiconsIcon
            icon={ArrowExpand01Icon}
            data-icon="maximize-2"
            size={14}
            strokeWidth={2}
          />
        ) : (
          <HugeiconsIcon
            icon={BubbleChatIcon}
            data-icon="message-circle"
            size={14}
            strokeWidth={2}
          />
        )}
      </TabBarTrailingIconButton>
    );

    const hideWorkstationLabel = t("sessions:chat.hideWorkstation");
    const maximizeChatControl =
      !isSettingsRoute && isChatPanelVisible ? (
        <TabBarTrailingIconButton
          title={hideWorkstationLabel}
          shortcutId="maximize_chat"
          onClick={handleToggleChatPanelMaximized}
          className={chatPanelPosition === "left" ? "group" : undefined}
        >
          <WorkstationMaximizeChatIcon chatPanelPosition={chatPanelPosition} />
        </TabBarTrailingIconButton>
      ) : null;

    const shrinkWorkstationControl = !isSettingsRoute &&
      !isChatPanelVisible && (
        <TabBarTrailingIconButton
          title={chatPanelLabel}
          shortcutId="maximize_work_station"
          onClick={handleToggleChatPanel}
        >
          <HugeiconsIcon
            icon={ArrowShrink01Icon}
            data-icon="minimize-2"
            size={14}
            strokeWidth={2}
          />
        </TabBarTrailingIconButton>
      );

    // X close button shown only while the Settings slot is mounted:
    // hides the workstation surface and maximizes Settings. The
    // SettingsSlot's own Maximize2 button performs the same toggle from
    // the opposite side, so dismissing the workstation is reachable from
    // wherever the user's pointer currently is.
    const maximizeSettingsLabel = t("settings:panel.maximizeSettings");
    const closeWorkstationControl = isSettingsRoute ? (
      <TabBarTrailingIconButton
        title={maximizeSettingsLabel}
        shortcutId="maximize_chat"
        onClick={handleToggleChatPanelMaximized}
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          data-icon="x"
          size={14}
          strokeWidth={2}
        />
      </TabBarTrailingIconButton>
    ) : null;

    if (host === "code") {
      return (
        <>
          {plusMenuControl}
          {shrinkWorkstationControl}
          {chatPanelControl}
          {maximizeChatControl}
          {closeWorkstationControl}
        </>
      );
    }

    if (host === "project" && projectTabBar) {
      const activeRawId =
        visible.find((entry) => entry.isActive)?.tab.id ??
        visible[0]?.tab.id ??
        null;
      return (
        <>
          {plusMenuControl}
          <ProjectManagerWorkItemsTabBarTrailing
            activeTabId={activeRawId}
            onAddProject={projectTabBar.onAddProject}
          />
          {shrinkWorkstationControl}
          {chatPanelControl}
          {maximizeChatControl}
          {closeWorkstationControl}
        </>
      );
    }

    return (
      <>
        {plusMenuControl}
        {shrinkWorkstationControl}
        {chatPanelControl}
        {maximizeChatControl}
        {closeWorkstationControl}
      </>
    );
  }, [
    host,
    handleToggleChatPanel,
    handleToggleChatPanelMaximized,
    isChatPanelVisible,
    isSettingsRoute,
    projectTabBar,
    t,
    visible,
    chatPanelPosition,
  ]);

  return { trailingSlot, handleToggleChatPanel };
}
