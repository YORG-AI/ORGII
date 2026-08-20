import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { useWorkStationPanels } from "@src/hooks/tabHost/useWorkStationPanels";
import { perAppStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";

interface UseAppShellStatusBarOptions {
  primaryPanelCollapsed: boolean;
  showSettingsButton: boolean;
  showCodeEditorBottomPanelToggle: boolean;
  handleOpenSettings: () => void;
  workStationPanels: ReturnType<typeof useWorkStationPanels>;
}

export function useAppShellStatusBar({
  primaryPanelCollapsed,
  showSettingsButton,
  showCodeEditorBottomPanelToggle,
  handleOpenSettings,
  workStationPanels,
}: UseAppShellStatusBarOptions): void {
  const setPerAppStatusBarCallbacks = useSetAtom(perAppStatusBarCallbacksAtom);

  useEffect(() => {
    // Panel callbacks tied to the shared `workStationPrimarySidebarCollapsedAtom`.
    // Browser has its own sidebar atom (`workStationBrowserSidebarCollapsedAtom`)
    // and registers its own panel callbacks from useBrowserLayoutState — do NOT
    // overwrite the browser slot here, otherwise toggling Code Editor's sidebar
    // would clobber Browser's primaryPanelCollapsed and make the Browser tab bar
    // app-switcher flicker based on an unrelated app's state.
    const sharedPanelCallbacks = {
      onTogglePrimaryPanel: workStationPanels.togglePrimarySidebar,
      primaryPanelCollapsed,
      layoutMode: workStationPanels.layoutMode,
    };
    setPerAppStatusBarCallbacks((prev) => ({
      ...prev,
      code: {
        ...prev.code,
        onOpenSettings: showSettingsButton ? handleOpenSettings : undefined,
        ...sharedPanelCallbacks,
        onToggleBottomPanel: showCodeEditorBottomPanelToggle
          ? workStationPanels.toggleBottomPanel
          : undefined,
        bottomPanelCollapsed: showCodeEditorBottomPanelToggle
          ? workStationPanels.bottomPanelCollapsed
          : undefined,
      },
      project: {
        ...prev.project,
        onOpenSettings: showSettingsButton ? handleOpenSettings : undefined,
        ...sharedPanelCallbacks,
      },
      data: {
        ...prev.data,
        ...sharedPanelCallbacks,
      },
    }));
  }, [
    handleOpenSettings,
    showSettingsButton,
    showCodeEditorBottomPanelToggle,
    setPerAppStatusBarCallbacks,
    workStationPanels.togglePrimarySidebar,
    primaryPanelCollapsed,
    workStationPanels.layoutMode,
    workStationPanels.toggleBottomPanel,
    workStationPanels.bottomPanelCollapsed,
  ]);
}
