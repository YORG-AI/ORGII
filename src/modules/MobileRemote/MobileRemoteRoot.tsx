import React from "react";

import { MobileRemoteApp } from "./MobileRemoteApp";
import { MobileAuthGate } from "./auth/MobileAuthGate";
import {
  type MobileRemotePlatform,
  MobileRemotePlatformProvider,
} from "./platform";

export interface MobileRemoteRootProps {
  platform: MobileRemotePlatform;
  relayUrl?: string;
}

/** Platform-neutral authenticated root shared by the Web and Tauri shells. */
export function MobileRemoteRoot({
  platform,
  relayUrl,
}: MobileRemoteRootProps) {
  return (
    <MobileRemotePlatformProvider platform={platform}>
      <MobileAuthGate>
        {({ authUserId, recoveredPairingIntent }) => (
          <MobileRemoteApp
            authUserId={authUserId}
            recoveredPairingIntent={recoveredPairingIntent}
            relayUrl={relayUrl}
          />
        )}
      </MobileAuthGate>
    </MobileRemotePlatformProvider>
  );
}

MobileRemoteRoot.displayName = "MobileRemoteRoot";
