import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { useWorkStationPanels } from "@src/hooks/tabHost/useWorkStationPanels";
import { simulatorPrimarySidebarPositionAtom } from "@src/store/ui/simulatorAtom";

export function useAppShellSimulatorPanelSync({
  isAgentStation,
  workStationPanels,
}: {
  isAgentStation: boolean;
  workStationPanels: ReturnType<typeof useWorkStationPanels>;
}): void {
  const setSimSidebarPosition = useSetAtom(simulatorPrimarySidebarPositionAtom);

  useEffect(() => {
    if (!isAgentStation) return;
    setSimSidebarPosition(workStationPanels.layoutMode);
  }, [isAgentStation, workStationPanels.layoutMode, setSimSidebarPosition]);
}
