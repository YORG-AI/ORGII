import { useSetAtom } from "jotai";
import { useEffect } from "react";

import { globalPlanningIndicatorBridgeOutputAtom } from "@src/engines/SessionCore/derived/planningIndicatorBridgeOutputAtom";
import { usePlanningIndicator } from "@src/engines/SessionCore/hooks/replay/usePlanningIndicator";

/**
 * Keeps the global planning footer output atom in sync without mounting the
 * hot subscriptions inside PlanningIndicatorBridge.
 */
export function useGlobalPlanningIndicatorBridgeSync(): void {
  const state = usePlanningIndicator(undefined);
  const setOutput = useSetAtom(globalPlanningIndicatorBridgeOutputAtom);

  useEffect(() => {
    setOutput((previous) =>
      previous.count === state.count &&
      previous.variantIndex === state.variantIndex
        ? previous
        : state
    );
  }, [state, setOutput]);
}

function GlobalPlanningIndicatorBridgeSync(): null {
  useGlobalPlanningIndicatorBridgeSync();
  return null;
}

export default GlobalPlanningIndicatorBridgeSync;
