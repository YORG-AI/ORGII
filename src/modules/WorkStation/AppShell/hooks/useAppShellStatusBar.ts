import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { useWorkStationPanels } from "@src/hooks/tabHost/useWorkStationPanels";
import {
  openBranchSpotlight,
  openWorkspaceSpotlight,
  openWorktreeSpotlight,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { perAppStatusBarCallbacksAtom } from "@src/store/ui/workStationAtom";

/**
 * Workspace / branch / worktree buttons in the code status bar. They are pure
 * GlobalSpotlight openers with no host-local state, so the AppShell owns them:
 * the status bar renders whenever the shell does, while the code host unmounts
 * on the empty Launchpad (see `hostMountPolicy.ts`). Registering them from the
 * host left the buttons dead there.
 *
 * Module-level so the identity is stable across renders.
 */
const SPOTLIGHT_CALLBACKS = {
  onRepoClick: () => openWorkspaceSpotlight("switch"),
  onBranchClick: openBranchSpotlight,
  onWorktreeClick: openWorktreeSpotlight,
} as const;

interface UseAppShellStatusBarOptions {
  primaryPanelCollapsed: boolean;
  showSettingsButton: boolean;
  handleOpenSettings: () => void;
  workStationPanels: ReturnType<typeof useWorkStationPanels>;
}

export function useAppShellStatusBar({
  primaryPanelCollapsed,
  showSettingsButton,
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
        ...SPOTLIGHT_CALLBACKS,
        onOpenSettings: showSettingsButton ? handleOpenSettings : undefined,
        ...sharedPanelCallbacks,
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
    setPerAppStatusBarCallbacks,
    workStationPanels.togglePrimarySidebar,
    primaryPanelCollapsed,
    workStationPanels.layoutMode,
  ]);
}
