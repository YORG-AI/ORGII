import React from "react";

import { useKeepAliveWindow } from "@src/hooks/ui/useKeepAliveWindow";
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

/**
 * Keep-alive window for chat-pane terminals. Two warm terminals cover the
 * common "compare two shells" flip; 30 s is long enough to survive a glance
 * at another tab and short enough that abandoned terminals stop holding
 * their buffers.
 */
export const CHAT_TERMINAL_KEEP_ALIVE = {
  graceMs: 30_000,
  maxWarm: 2,
} as const;

interface UnifiedChatPanelTabContentProps {
  activeTab: ChatPanelTab | null;
  /** Whether the host is currently rendering its tab row. */
  hasTabBar: boolean;
  /** The shared "chat column" node (session transcript, Launchpad / creators).
   *  Built by the host so this dispatcher stays
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
 *  - terminal tabs use a bounded keep-alive window (see
 *    `CHAT_TERMINAL_KEEP_ALIVE`): the active terminal plus the most recently
 *    deactivated one stay mounted (hidden) for a grace period so flipping
 *    between two tabs is instant; older ones unmount. Unmounting a terminal
 *    only tears down the xterm instance and its 5,000-line buffer — the PTY
 *    keeps running in Rust, the buffer is serialized into `bufferCache`, and
 *    remounting restores it through `attach_pty_stream` (cached buffer, or the
 *    Rust snapshot when output arrived while unmounted). This is the same path
 *    the code editor's terminal pane already relies on.
 * A tab whose type is not in the registry renders an explicit placeholder
 * rather than silently collapsing to the Launchpad.
 */
export function UnifiedChatPanelTabContent({
  activeTab,
  chatColumn,
  hasTabBar,
  isTerminalTabActive,
  terminalTabs,
}: UnifiedChatPanelTabContentProps): React.ReactNode {
  const terminalTabIds = React.useMemo(
    () => terminalTabs.map((tab) => tab.id),
    [terminalTabs]
  );
  const activeTerminalTabId =
    isTerminalTabActive && activeTab ? activeTab.id : null;
  const mountedTerminalTabIds = useKeepAliveWindow(
    activeTerminalTabId,
    terminalTabIds,
    CHAT_TERMINAL_KEEP_ALIVE
  );

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
            <WorkManagement hasTabBar={hasTabBar} />
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
        if (!mountedTerminalTabIds.has(tab.id)) return null;
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
