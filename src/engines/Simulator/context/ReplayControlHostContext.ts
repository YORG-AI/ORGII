import { createContext } from "react";

/** True when a parent host (for example Cloud Web) owns replay transport UI. */
export const ReplayControlHostContext = createContext(false);
