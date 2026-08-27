/**
 * useSimulatorAppRenderer Hook
 *
 * Provides a renderer function that dynamically loads and renders
 * the appropriate simulator app based on event type.
 */
import React, { Suspense, useCallback } from "react";

import { Placeholder } from "@src/components/Placeholder";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";
import { createLogger } from "@src/hooks/logger";

import {
  getAppForEvent as getAppForEventFromRegistry,
  getSimulatorAppConfig,
} from "./registry";

const log = createLogger("SimulatorAppRenderer");

// ============================================
// Types
// ============================================

export interface SimulatorAppRenderProps {
  currentEvent: unknown;
  mode?: "interactive" | "simulation";
  customControls?: React.ReactNode;
  [key: string]: unknown;
}

export interface UseSimulatorAppRendererReturn {
  renderApp: (
    appType: string | null,
    props: SimulatorAppRenderProps
  ) => React.ReactNode;
  getAppForEvent: (eventFunction: string) => string | null;
  hasApp: (appType: string) => boolean;
}

// ============================================
// Loading Fallback
// ============================================

const AppLoadingFallback: React.FC = () => (
  <div className="flex h-full min-h-0 w-full flex-col">
    <Placeholder
      variant="loading"
      placement="detail-panel"
      fillParentHeight
      title="Loading app..."
    />
  </div>
);

// ============================================
// Hook Implementation
// ============================================

export function useSimulatorAppRenderer(): UseSimulatorAppRendererReturn {
  const renderApp = useCallback(
    (
      appType: string | null,
      props: SimulatorAppRenderProps
    ): React.ReactNode => {
      if (!appType) {
        return null;
      }

      const config = getSimulatorAppConfig<SimulatorAppBaseState>(
        appType as never
      );
      if (!config) {
        log.warn(
          `[SimulatorAppRenderer] No app registered for type: ${appType}`
        );
        return null;
      }

      const AppComponent = config.component;

      return (
        <Suspense fallback={<AppLoadingFallback />}>
          <AppComponent
            state={{} as SimulatorAppBaseState}
            selectedItemId={null}
            onSelectItem={function (): void {
              throw new Error("Function not implemented.");
            }}
            {...props}
          />
        </Suspense>
      );
    },
    []
  );

  const getAppForEvent = useCallback((eventFunction: string): string | null => {
    return getAppForEventFromRegistry(eventFunction);
  }, []);

  const hasApp = useCallback((appType: string): boolean => {
    return getSimulatorAppConfig(appType as never) !== null;
  }, []);

  return {
    renderApp,
    getAppForEvent,
    hasApp,
  };
}

export default useSimulatorAppRenderer;
