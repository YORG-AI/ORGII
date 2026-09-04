import React, { useCallback, useEffect, useRef } from "react";

import { useMobileRemote } from "../app";
import type { MobileConnectionConfig } from "../connection/types";
import { useMobileRemotePlatform } from "../platform";
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
  const { runtime } = useMobileRemotePlatform();
  const startedRef = useRef(false);

  const runDemoConnecting = useCallback(() => {
    const timer = runtime.setTimeout(onComplete, 900);
    return () => runtime.clearTimeout(timer);
  }, [onComplete, runtime]);

  useEffect(() => {
    startedRef.current = false;
  }, [pendingConfig]);

  // The demo timer and the live connect are separate attempts with separate
  // inputs. Keeping them in one effect put demoMode in the live path's
  // dependencies, and connectLive clears demoMode partway through pairing:
  // the resulting re-run cancelled the in-flight attempt through its cleanup,
  // then refused to retry because startedRef was already set, stranding the
  // user on the connecting screen.
  useEffect(() => {
    if (startedRef.current || pendingConfig || !demoMode) return;
    startedRef.current = true;
    return runDemoConnecting();
  }, [demoMode, pendingConfig, runDemoConnecting]);

  useEffect(() => {
    if (startedRef.current || !pendingConfig) return;

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
  }, [connectLive, onComplete, pendingConfig]);

  return <ConnectingScreen />;
}

ConnectingLiveBridge.displayName = "ConnectingLiveBridge";
