/**
 * AppProviders
 *
 * Outermost React context layer. Wraps the app with a Jotai `Provider` backed
 * by an instrumented store (DevTools-aware atom tracking).
 *
 * Mounted once in main.tsx above AppBootstrap. Nothing else should add
 * global providers here; use the appropriate context location instead.
 */
import { Provider } from "jotai";
import React, { useMemo } from "react";

import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export const AppProviders: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const instrumentedStore = useMemo(() => createInstrumentedStore(), []);

  return <Provider store={instrumentedStore}>{children}</Provider>;
};
