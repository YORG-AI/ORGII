import { atom } from "jotai";

import type { PlanningIndicatorState } from "../hooks/replay/usePlanningIndicator";

export const globalPlanningIndicatorBridgeOutputAtom =
  atom<PlanningIndicatorState>({
    count: 0,
    variantIndex: 0,
  });

globalPlanningIndicatorBridgeOutputAtom.debugLabel =
  "planning/globalBridgeOutput";
