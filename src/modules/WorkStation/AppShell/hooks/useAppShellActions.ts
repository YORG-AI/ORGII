import { useCallback } from "react";

import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";

interface AppShellActions {
  handleSelectRepo: () => void;
  handleOpenSettings: () => void;
}

export function useAppShellActions(): AppShellActions {
  const { goToSettings } = useAppNavigation();

  const handleSelectRepo = useCallback(() => {
    openWorkspaceSpotlight("switch");
  }, []);

  const handleOpenSettings = useCallback(() => {
    goToSettings({ section: "appearance", tab: "code-editor" });
  }, [goToSettings]);

  return { handleSelectRepo, handleOpenSettings };
}
