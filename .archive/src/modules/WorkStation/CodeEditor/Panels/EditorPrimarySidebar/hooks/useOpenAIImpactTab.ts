/**
 * useOpenAIImpactTab Hook
 *
 * Opens an AI Impact dashboard tab in the single main pane.
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import {
  createAIImpactTab,
  openTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";

export function useOpenAIImpactTab(): () => void {
  const setLayout = useSetAtom(workstationLayoutAtom);

  return useCallback(() => {
    const tab = createAIImpactTab();
    setLayout((prev) => ({
      ...prev,
      mainPane: openTab(prev?.mainPane ?? { tabs: [], activeTabId: null }, tab),
    }));
  }, [setLayout]);
}
