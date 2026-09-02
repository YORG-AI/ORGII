import React from "react";

import { MIN_WIDTH as CHAT_MIN_WIDTH } from "@src/engines/ChatPanel/config";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

import { UnifiedChatPanelTabContent } from "./TabContent/UnifiedChatPanelTabContent";

type ChatPanelShellStyle = React.CSSProperties;

interface ChatPanelShellProps {
  activeTab: ChatPanelTab | null;
  borderClasses: string;
  chatColumn: React.ReactNode;
  chatPanelOpacityStyle: ChatPanelShellStyle;
  chatWidth: number;
  chatWidthStyleValue: string | number;
  embedded: boolean;
  focusedWorkstationRail?: React.ReactNode;
  headerSection: React.ReactNode;
  isDragging: boolean;
  isLeftPosition: boolean;
  isTerminalTabActive: boolean;
  onResizeMouseDown: React.MouseEventHandler;
  panelRef: React.RefObject<HTMLDivElement | null>;
  resizeIndicatorHost?: HTMLElement | null;
  resizeTooltipLabel: React.ReactNode;
  resizeTooltipShortcut: string;
  sessionModals: React.ReactNode;
  showResizeHandle: boolean;
  terminalTabs: ChatPanelTab[];
  useExternalWidth: boolean;
}

export function ChatPanelShell({
  activeTab,
  borderClasses,
  chatColumn,
  chatPanelOpacityStyle,
  chatWidth,
  chatWidthStyleValue,
  embedded,
  focusedWorkstationRail,
  headerSection,
  isDragging,
  isLeftPosition,
  isTerminalTabActive,
  onResizeMouseDown,
  panelRef,
  resizeIndicatorHost,
  resizeTooltipLabel,
  resizeTooltipShortcut,
  sessionModals,
  showResizeHandle,
  terminalTabs,
  useExternalWidth,
}: ChatPanelShellProps): React.ReactNode {
  const dragHandle = showResizeHandle && (
    <VerticalResizeHandle
      key="chat-panel-resize-handle"
      className={`z-80! ${isLeftPosition ? "-ml-px" : "-mr-px"}`}
      indicatorHost={resizeIndicatorHost}
      indicatorPlacement={
        resizeIndicatorHost ? "center" : isLeftPosition ? "start" : "end"
      }
      isResizing={isDragging}
      onMouseDown={onResizeMouseDown}
      tooltipLabel={resizeTooltipLabel}
      tooltipShortcut={resizeTooltipShortcut}
      variant={embedded ? "border" : "transparent"}
      noAccent={!embedded}
    />
  );

  const mainPanel = (
    <div
      key="chat-panel-main"
      ref={panelRef}
      data-chat-panel
      data-testid="chat-panel"
      data-guide-target={GUIDE_TARGETS.CHAT_PANEL}
      className={`@container/focusedchat relative flex h-full max-w-full flex-col overflow-hidden bg-chat-pane text-sm ${
        useExternalWidth ? "min-w-0 flex-1" : "shrink-0"
      } ${borderClasses}`}
      style={{
        ...(useExternalWidth
          ? { width: "100%" }
          : { width: chatWidthStyleValue }),
        minWidth:
          !useExternalWidth && chatWidth > 0 ? CHAT_MIN_WIDTH : undefined,
        borderRadius: embedded ? 0 : "var(--radius-page)",
        contain: isDragging ? "strict" : undefined,
        willChange: isDragging ? "width" : undefined,
        ...chatPanelOpacityStyle,
      }}
    >
      {headerSection}
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1">
          <UnifiedChatPanelTabContent
            activeTab={activeTab}
            chatColumn={chatColumn}
            isTerminalTabActive={isTerminalTabActive}
            terminalTabs={terminalTabs}
          />
        </div>
        {focusedWorkstationRail}
      </div>
    </div>
  );

  const panelChildren = isLeftPosition
    ? [mainPanel, dragHandle]
    : [dragHandle, mainPanel];

  return (
    <>
      <div
        className={`relative flex h-full flex-row ${
          useExternalWidth ? "w-full min-w-0" : "shrink-0"
        }`}
      >
        {panelChildren}
      </div>
      {sessionModals}
    </>
  );
}
