import type { FC } from "react";

import { useGlobalShortcuts } from "@src/hooks/navigation/useGlobalShortcuts";
import { useSetupWalkthroughTestShortcut } from "@src/modules/SetupWalkthrough/useSetupWalkthroughTestShortcut";

export const GlobalShortcuts: FC = () => {
  // Register first so the exact hidden test chord is consumed before regular
  // route-level shortcuts observe the event.
  useSetupWalkthroughTestShortcut();
  useGlobalShortcuts();

  return null;
};

export default GlobalShortcuts;
