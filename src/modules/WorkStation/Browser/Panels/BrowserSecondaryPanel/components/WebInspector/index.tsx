/**
 * WebInspector
 *
 * Right sidebar for Browser's web browsing mode containing DevTools.
 * Wraps the WebDevTools component.
 *
 * Note: Width and resize are handled by WorkStationShell, not this component.
 *
 * Features:
 * - Contains DevTools tabs (Elements, Console, Network)
 * - Collapsed state shows toggle button with error/warning indicators
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { HugeiconsIcon, PanelRightOpenIcon } from "@src/icons";
import type { ElementInfo } from "@src/modules/WorkStation/Browser/hooks/useWebviewInspector";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import type { SecondaryPanelPosition } from "@src/store/ui/workStationAtom";

import WebDevTools, {
  type ConsoleEntry,
  type NetworkEntry,
} from "../WebDevTools";

// ============================================
// Types
// ============================================

export interface WebInspectorProps {
  /** Whether panel is collapsed */
  isCollapsed: boolean;
  /** Toggle panel collapse */
  onToggleCollapse: () => void;
  /** Panel width */
  width: number;
  /** Callback when width changes */
  onWidthChange: (width: number) => void;
  /** Console entries */
  entries: ConsoleEntry[];
  /** Clear console entries */
  onClearEntries: () => void;
  /** Network entries */
  networkEntries?: NetworkEntry[];
  /** Clear network entries */
  onClearNetworkEntries?: () => void;
  /** Error count */
  errorCount: number;
  /** Warning count */
  warningCount: number;
  /** Selected element from inspector */
  selectedElement?: ElementInfo | null;
  /** Webview label for DOM tree */
  webviewLabel?: string;
  /** Repository path for source navigation */
  repoPath?: string;
  /** Current page URL (triggers DOM refresh on navigation) */
  currentUrl?: string;
  /** Position of the panel (right or bottom) */
  position?: SecondaryPanelPosition;
  /** Toggle the panel position */
  onTogglePosition?: () => void;
}

// ============================================
// Component
// ============================================

export const WebInspector: React.FC<WebInspectorProps> = memo(
  ({
    isCollapsed,
    onToggleCollapse,
    width: _width,
    onWidthChange: _onWidthChange,
    entries,
    onClearEntries,
    networkEntries,
    onClearNetworkEntries,
    errorCount,
    warningCount,
    selectedElement,
    webviewLabel,
    repoPath,
    currentUrl,
    position,
    onTogglePosition,
  }) => {
    const { t } = useTranslation("sessions");
    // Note: Width and resize are handled by WorkStationShell, not here
    void _width;
    void _onWidthChange;

    // Collapsed state - show toggle button only
    // Note: No border-l here - WorkStationShell provides the resize handle separator
    if (isCollapsed) {
      return (
        <div className="station-sidebar-scroll-area flex h-full w-8 shrink-0 flex-col items-center bg-workstation-bg pt-2">
          <ToolbarTooltip label={t("titleBar.showDevTools")}>
            <button
              type="button"
              className={HEADER_BUTTON.actionLg}
              onClick={onToggleCollapse}
              aria-label={t("titleBar.showDevTools")}
            >
              <HugeiconsIcon
                icon={PanelRightOpenIcon}
                data-icon="panel-right-open"
                size={16}
              />
            </button>
          </ToolbarTooltip>
          {/* Issue indicators */}
          {(errorCount > 0 || warningCount > 0) && (
            <div className="mt-2 flex flex-col items-center gap-1">
              {errorCount > 0 && (
                <span className="text-[10px] font-medium text-danger-6">
                  {errorCount}
                </span>
              )}
              {warningCount > 0 && (
                <span className="text-[10px] font-medium text-warning-6">
                  {warningCount}
                </span>
              )}
            </div>
          )}
        </div>
      );
    }

    // Expanded state - WebDevTools handles its own header and tabs
    // Width and resize handle are provided by WorkStationShell
    return (
      <WebDevTools
        isOpen={true}
        onClose={onToggleCollapse}
        entries={entries}
        onClearEntries={onClearEntries}
        networkEntries={networkEntries}
        onClearNetworkEntries={onClearNetworkEntries}
        selectedElement={selectedElement}
        webviewLabel={webviewLabel}
        repoPath={repoPath}
        currentUrl={currentUrl}
        position={position}
        onTogglePosition={onTogglePosition}
      />
    );
  }
);

WebInspector.displayName = "WebInspector";

export default WebInspector;
