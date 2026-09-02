import React, { useEffect, useMemo, useState } from "react";

import { MobileRemoteApp } from "../MobileRemoteApp";
import { MobileAuthContext } from "../auth/MobileAuthContext";
import type { MobileAuthSession } from "../auth/mobileAuthState";
import {
  type MobileRemotePlatform,
  MobileRemotePlatformProvider,
} from "../platform";

const DEVELOPMENT_PAIRING_USER_ID = "local-development";

function createDevelopmentAuthSession(userId: string): MobileAuthSession {
  return {
    kind: "org2_cloud",
    supabaseUrl: "https://local-development.invalid",
    supabaseAnonKey: "local-development",
    userId,
    accessToken: "local-development",
    refreshToken: "local-development",
    expiresAt: 4_102_444_800,
    profile: { displayName: "Local development" },
  };
}

/**
 * Development skips Cloud authentication, but pairing ownership still needs a
 * stable Keychain scope. Prefer an existing development inventory; otherwise
 * reuse the last signed-in account so enabling the bypass does not orphan its
 * paired desktops.
 */
export async function resolveDevelopmentPairingUserId(
  platform: MobileRemotePlatform
): Promise<string> {
  const [developmentInventory, storedSession] = await Promise.allSettled([
    platform.connection.listPairedDesktops(DEVELOPMENT_PAIRING_USER_ID),
    platform.auth.readSession(),
  ]);
  if (
    developmentInventory.status === "fulfilled" &&
    developmentInventory.value.length > 0
  ) {
    return DEVELOPMENT_PAIRING_USER_ID;
  }
  if (storedSession.status === "fulfilled") {
    const storedUserId = storedSession.value?.userId.trim();
    if (storedUserId) return storedUserId;
  }
  return DEVELOPMENT_PAIRING_USER_ID;
}

export interface MobileRemoteDevelopmentRootProps {
  platform: MobileRemotePlatform;
  pairingUserId?: string;
}

/**
 * Local native-development root. The production entry removes this dynamic
 * module entirely, so release builds cannot construct the synthetic identity.
 */
export function MobileRemoteDevelopmentRoot({
  platform,
  pairingUserId = DEVELOPMENT_PAIRING_USER_ID,
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

  const auth = useMemo(() => {
    const session = createDevelopmentAuthSession(pairingUserId);
    return {
      session,
      signOut: () => undefined,
      isDevelopmentBypass: true,
    };
  }, [pairingUserId]);

  return (
    <MobileRemotePlatformProvider platform={platform}>
      <MobileAuthContext.Provider value={auth}>
        <MobileRemoteApp
          authUserId={pairingUserId}
          recoveredPairingIntent={recoveredPairingIntent}
        />
      </MobileAuthContext.Provider>
    </MobileRemotePlatformProvider>
  );
}

MobileRemoteDevelopmentRoot.displayName = "MobileRemoteDevelopmentRoot";
