/**
 * BottomPanelContent Component
 *
 * Renders the tab content switcher for the bottom panel.
 * Keeps all tabs mounted (display:none) to preserve state.
 */
import { type FC, memo } from "react";

import {
  BOTTOM_PANEL_TABS,
  type BottomPanelTab,
} from "@src/store/ui/workStationAtom";

import type { TabConfig } from "../types";

interface BottomPanelContentProps {
  activeTab: BottomPanelTab;
  // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
  // terminalTab: TabConfig;
  problemsTab: TabConfig;
  outputTab: TabConfig;
  testResultsTab: TabConfig;
}

const TAB_ENTRIES = [
  // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
  // { key: BOTTOM_PANEL_TABS.TERMINAL, className: "flex h-full w-full" },
  { key: BOTTOM_PANEL_TABS.PROBLEMS, className: "h-full w-full" },
  { key: BOTTOM_PANEL_TABS.OUTPUT, className: "h-full w-full" },
  { key: BOTTOM_PANEL_TABS.TEST_RESULTS, className: "h-full w-full" },
] as const;

const BottomPanelContent: FC<BottomPanelContentProps> = memo(
  ({ activeTab, problemsTab, outputTab, testResultsTab }) => {
    const visibleActiveTab =
      activeTab === BOTTOM_PANEL_TABS.TERMINAL
        ? BOTTOM_PANEL_TABS.PROBLEMS
        : activeTab;

    const tabMap: Record<string, TabConfig> = {
      // Bottom-panel Terminal is intentionally hidden while the standalone Terminal tab is the single source of truth.
      // [BOTTOM_PANEL_TABS.TERMINAL]: terminalTab,
      [BOTTOM_PANEL_TABS.PROBLEMS]: problemsTab,
      [BOTTOM_PANEL_TABS.OUTPUT]: outputTab,
      [BOTTOM_PANEL_TABS.TEST_RESULTS]: testResultsTab,
    };

    return (
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {TAB_ENTRIES.map(({ key, className }) => (
          <div
            key={key}
            style={{ display: visibleActiveTab === key ? "flex" : "none" }}
            className={className}
          >
            {tabMap[key]?.content}
          </div>
        ))}
      </div>
    );
  }
);

BottomPanelContent.displayName = "BottomPanelContent";

export default BottomPanelContent;
