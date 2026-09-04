import { createContext, useContext } from "react";

import type { MobileAuthSession } from "./mobileAuthState";

export interface MobileAuthContextValue {
  session: MobileAuthSession;
  signOut: () => void;
}

export const MobileAuthContext = createContext<MobileAuthContextValue | null>(
  null
);

export function useMobileAuth(): MobileAuthContextValue {
  const value = useContext(MobileAuthContext);
  if (!value) {
    throw new Error("useMobileAuth must be used within MobileAuthGate");
  }
  return value;
}
