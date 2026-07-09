import React from "react";

import { MIN_WIDTH as CHAT_MIN_WIDTH } from "@src/engines/ChatPanel/config";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

import { ChatPanelTerminalContent } from "./ChatPanelTerminalContent";

type ChatPanelShellStyle = React.CSSProperties;

interface ChatPanelShellProps {
  activeTab: ChatPanelTab | null;
  borderClasses: string;
  chatColumn: React.ReactNode;
  chatPanelOpacityStyle: ChatPanelShellStyle;
  chatWidth: number;
  chatWidthStyleValue: string | number;
  embedded: boolean;
  headerSection: React.ReactNode;
  isDragging: boolean;
  isLeftPosition: boolean;
  isTerminalTabActive: boolean;
  onResizeMouseDown: React.MouseEventHandler;
  panelRef: React.RefObject<HTMLDivElement | null>;
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
  headerSection,
  isDragging,
  isLeftPosition,
  isTerminalTabActive,
  onResizeMouseDown,
  panelRef,
  sessionModals,
  showResizeHandle,
  terminalTabs,
  useExternalWidth,
}: ChatPanelShellProps): React.ReactNode {
  const dragHandle = showResizeHandle && (
    <VerticalResizeHandle
      key="chat-panel-resize-handle"
      onMouseDown={onResizeMouseDown}
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
      className={`relative flex h-full max-w-full flex-col overflow-hidden bg-chat-pane text-sm ${
        useExternalWidth ? "min-w-0 flex-1" : "flex-shrink-0"
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
      <div style={{ display: isTerminalTabActive ? "none" : "contents" }}>
        {chatColumn}
      </div>
      {terminalTabs.map((tab) => {
        const terminalSessionId = tab.terminalSessionId;
        if (!terminalSessionId) return null;
        const isActive = isTerminalTabActive && tab.id === activeTab?.id;
        return (
          <div
            key={tab.id}
            style={{ display: isActive ? "flex" : "none" }}
            className="min-h-0 w-full flex-1 flex-col overflow-hidden"
          >
            <ChatPanelTerminalContent
              tabId={tab.id}
              terminalSessionId={terminalSessionId}
              cliCommand={tab.cliCommand}
              visible={isActive}
            />
          </div>
        );
      })}
    </div>
  );

  const panelChildren = isLeftPosition
    ? [mainPanel, dragHandle]
    : [dragHandle, mainPanel];

  return (
    <>
      <div
        className={`relative flex h-full flex-row ${
          useExternalWidth ? "w-full min-w-0" : "flex-shrink-0"
        }`}
      >
        {panelChildren}
      </div>
      {sessionModals}
    </>
  );
}
