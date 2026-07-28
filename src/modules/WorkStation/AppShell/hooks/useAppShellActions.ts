import { useAtomValue, useSetAtom } from "jotai";
import { useCallback } from "react";

import { openWorkspaceSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import {
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation/tabs";
import { createSettingsTab } from "@src/store/workstation/tabs/factories";

interface AppShellActions {
  handleSelectRepo: () => void;
  handleOpenSettings: () => void;
}

export function useAppShellActions(): AppShellActions {
  const workspace = useAtomValue(presentedWorkstationWorkspaceKeyAtom);
  const openWorkstationTab = useSetAtom(openWorkstationTabAtom);

  const handleSelectRepo = useCallback(() => {
    openWorkspaceSpotlight("switch");
  }, []);

  const handleOpenSettings = useCallback(() => {
    openWorkstationTab({
      workspace,
      tab: createSettingsTab(),
    });
  }, [openWorkstationTab, workspace]);

  return { handleSelectRepo, handleOpenSettings };
}
