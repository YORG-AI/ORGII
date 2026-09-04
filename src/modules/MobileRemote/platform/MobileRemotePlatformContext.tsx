import React, { createContext, useContext } from "react";

import type { MobileRemotePlatform } from "./types";

const MobileRemotePlatformContext = createContext<MobileRemotePlatform | null>(
  null
);

export interface MobileRemotePlatformProviderProps {
  platform: MobileRemotePlatform;
  children: React.ReactNode;
}

export function MobileRemotePlatformProvider({
  platform,
  children,
}: MobileRemotePlatformProviderProps) {
  return (
    <MobileRemotePlatformContext.Provider value={platform}>
      {children}
    </MobileRemotePlatformContext.Provider>
  );
}

export function useMobileRemotePlatform(): MobileRemotePlatform {
  const platform = useContext(MobileRemotePlatformContext);
  if (!platform) {
    throw new Error(
      "useMobileRemotePlatform must be used within MobileRemotePlatformProvider"
    );
  }
  return platform;
}

MobileRemotePlatformProvider.displayName = "MobileRemotePlatformProvider";
