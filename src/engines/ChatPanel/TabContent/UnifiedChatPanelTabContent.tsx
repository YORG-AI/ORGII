import React from "react";

import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

import { UnknownChatPanelTabPlaceholder } from "./UnknownChatPanelTabPlaceholder";
import { resolveChatPanelTabSurfaceEntry } from "./registry";

const WorkManagement = React.lazy(
  () => import("@src/modules/MainApp/WorkManagement")
);

// Lazy: pulls TerminalCore (xterm + addons), which only renders once the
// user opens a terminal tab in the chat pane.
const ChatPanelTerminalContent = React.lazy(() =>
  import("../ChatPanelTerminalContent").then((module) => ({
    default: module.ChatPanelTerminalContent,
  }))
);

interface UnifiedChatPanelTabContentProps {
  activeTab: ChatPanelTab | null;
  /** The shared "chat column" node (session transcript, Launchpad / creators,
   *  and the benchmark run-list). Built by the host so this dispatcher stays
   *  agnostic of its heavy prop surface. */
  chatColumn: React.ReactNode;
  isTerminalTabActive: boolean;
  terminalTabs: ChatPanelTab[];
}

/**
 * Registry-driven content dispatcher for the chat pane. Keys off the active
 * tab's type (via `CHAT_PANEL_TAB_SURFACE_REGISTRY`) to decide what is visible,
 * preserving keep-alive behavior:
 *  - the chat column stays mounted (hidden when another surface is active) so
 *    session state survives tab switches;
 *  - Work Management mounts only while its tab is active;
 *  - dedicated surface components (Runtime / workspace / cloud-org / work-item /
 *    project / project-org / explore) render from their tab payload;
 *  - every terminal tab stays mounted (hidden unless active) so PTY output is
 *    never lost.
 * A tab whose type is not in the registry renders an explicit placeholder
 * rather than silently collapsing to the Launchpad.
 */
export function UnifiedChatPanelTabContent({
  activeTab,
  chatColumn,
  isTerminalTabActive,
  terminalTabs,
}: UnifiedChatPanelTabContentProps): React.ReactNode {
  const entry = activeTab
    ? resolveChatPanelTabSurfaceEntry(activeTab.type)
    : null;

  if (activeTab && !entry) {
    return <UnknownChatPanelTabPlaceholder type={activeTab.type} />;
  }

  const isManagementTabActive = entry?.render === "work-management";
  const SurfaceComponent =
    entry?.render === "component" ? entry.Component : null;
  const hideChatColumn =
    isTerminalTabActive || isManagementTabActive || Boolean(SurfaceComponent);

  return (
    <>
      <div style={{ display: hideChatColumn ? "none" : "contents" }}>
        {chatColumn}
      </div>
      {isManagementTabActive && (
        <div className="min-h-0 w-full flex-1 overflow-hidden">
          <React.Suspense fallback={null}>
            <WorkManagement />
          </React.Suspense>
        </div>
      )}
      {SurfaceComponent && activeTab && (
        <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden">
          <SurfaceComponent tab={activeTab} />
        </div>
      )}
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
            <React.Suspense fallback={null}>
              <ChatPanelTerminalContent
                tabId={tab.id}
                terminalSessionId={terminalSessionId}
                cliCommand={tab.cliCommand}
                visible={isActive}
              />
            </React.Suspense>
          </div>
        );
      })}
    </>
  );
}
