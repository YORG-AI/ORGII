import type { FC } from "react";

import { useGlobalShortcuts } from "@src/hooks/navigation/useGlobalShortcuts";

export const GlobalShortcuts: FC = () => {
  useGlobalShortcuts();

  return null;
};

export default GlobalShortcuts;
