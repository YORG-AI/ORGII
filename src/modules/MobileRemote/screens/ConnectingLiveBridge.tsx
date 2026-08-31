import React, { useCallback, useEffect, useRef } from "react";

import { useMobileRemote } from "../app";
import type { MobileConnectionConfig } from "../connection/types";
import { ConnectingScreen } from "./ConnectingScreen";

export interface ConnectingLiveBridgeProps {
  pendingConfig: MobileConnectionConfig | null;
  demoMode: boolean;
  onComplete: () => void;
}

/** Runs connectLive for parsed pairing config, or demo timer when unconfigured. */
export function ConnectingLiveBridge({
  pendingConfig,
  demoMode,
  onComplete,
}: ConnectingLiveBridgeProps) {
  const { connectLive } = useMobileRemote();
  const startedRef = useRef(false);

  const runDemoConnecting = useCallback(() => {
    const timer = window.setTimeout(onComplete, 900);
    return () => window.clearTimeout(timer);
  }, [onComplete]);

  useEffect(() => {
    startedRef.current = false;
  }, [pendingConfig]);

  useEffect(() => {
    if (startedRef.current) return;

    if (!pendingConfig) {
      if (demoMode) {
        startedRef.current = true;
        return runDemoConnecting();
      }
      return;
    }

    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      try {
        await connectLive(pendingConfig);
        if (cancelled) return;
        onComplete();
      } catch {
        // ConnectionErrorScreen handles connection.status === "error".
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectLive, demoMode, onComplete, pendingConfig, runDemoConnecting]);

  return <ConnectingScreen />;
}

ConnectingLiveBridge.displayName = "ConnectingLiveBridge";
