import React, { useEffect, useMemo, useState } from "react";

import { MobileRemoteApp } from "../MobileRemoteApp";
import { MobileAuthContext } from "../auth/MobileAuthContext";
import type { MobileAuthSession } from "../auth/mobileAuthState";
import {
  type MobileRemotePlatform,
  MobileRemotePlatformProvider,
} from "../platform";

const DEVELOPMENT_AUTH_SESSION = {
  kind: "org2_cloud",
  supabaseUrl: "https://local-development.invalid",
  supabaseAnonKey: "local-development",
  userId: "local-development",
  accessToken: "local-development",
  refreshToken: "local-development",
  expiresAt: 4_102_444_800,
  profile: { displayName: "Local development" },
} as const satisfies MobileAuthSession;

export interface MobileRemoteDevelopmentRootProps {
  platform: MobileRemotePlatform;
}

/**
 * Local native-development root. The production entry removes this dynamic
 * module entirely, so release builds cannot construct the synthetic identity.
 */
export function MobileRemoteDevelopmentRoot({
  platform,
}: MobileRemoteDevelopmentRootProps) {
  const [recoveredPairingIntent, setRecoveredPairingIntent] = useState(() =>
    platform.auth.captureInitialPairingIntent()
  );

  useEffect(() => {
    let active = true;
    let consumeChain = Promise.resolve();
    const consumePairingIntent = () => {
      const operation = consumeChain
        .then(() => platform.auth.consumePairingIntent())
        .then((intent) => {
          if (active && intent) setRecoveredPairingIntent(intent);
        });
      consumeChain = operation.catch(() => undefined);
    };

    consumePairingIntent();
    const unsubscribe = platform.auth.subscribeIntent((event) => {
      if (event === "pairing") consumePairingIntent();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [platform.auth]);

  const auth = useMemo(
    () => ({
      session: DEVELOPMENT_AUTH_SESSION,
      signOut: () => undefined,
      isDevelopmentBypass: true,
    }),
    []
  );

  return (
    <MobileRemotePlatformProvider platform={platform}>
      <MobileAuthContext.Provider value={auth}>
        <MobileRemoteApp
          authUserId={DEVELOPMENT_AUTH_SESSION.userId}
          recoveredPairingIntent={recoveredPairingIntent}
        />
      </MobileAuthContext.Provider>
    </MobileRemotePlatformProvider>
  );
}

MobileRemoteDevelopmentRoot.displayName = "MobileRemoteDevelopmentRoot";
