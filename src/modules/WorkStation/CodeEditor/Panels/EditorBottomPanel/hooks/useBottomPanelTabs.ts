/**
 * useBottomPanelTabs Hook
 *
 * Manages bottom panel tab state and tab change actions.
 */
import { useCallback } from "react";

import { useActionSystem } from "@src/ActionSystem";
import { useBottomPanelState } from "@src/hooks/tabHost/useWorkStationPanels";
import type { BottomPanelTab } from "@src/store/ui/workStationAtom";

interface UseBottomPanelTabsOptions {
  onTabChange?: (tab: BottomPanelTab) => void;
}

export function useBottomPanelTabs({
  onTabChange,
}: UseBottomPanelTabsOptions = {}) {
  const { dispatch } = useActionSystem();
  const { bottomPanelTab, bottomPanelCollapsed } = useBottomPanelState();

  const handleTabChange = useCallback(
    (tab: BottomPanelTab) => {
      dispatch("panel.showBottom", { panel: tab }, "user");
      onTabChange?.(tab);
    },
    [dispatch, onTabChange]
  );

  const handleTogglePanel = useCallback(() => {
    dispatch("panel.toggleBottom", {}, "user");
  }, [dispatch]);

  return {
    activeTab: bottomPanelTab,
    isCollapsed: bottomPanelCollapsed,
    handleTabChange,
    handleTogglePanel,
  };
}
