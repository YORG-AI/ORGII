import { parseStoredOrg2CloudAuth } from "@src/features/Org2Cloud/org2CloudAuthState";

import type { MobileAuthSession } from "./mobileAuthState";

/** Same browser-local representation used by the desktop ORG2 Cloud identity. */
export const MOBILE_AUTH_STORAGE_KEY = "orgii:org2-cloud-v1:auth";

export function readMobileAuthSession(
  storage: Pick<Storage, "getItem"> = localStorage
): MobileAuthSession | null {
  try {
    const raw = storage.getItem(MOBILE_AUTH_STORAGE_KEY);
    return parseStoredOrg2CloudAuth(raw);
  } catch {
    return null;
  }
}

export function writeMobileAuthSession(
  session: MobileAuthSession,
  storage: Pick<Storage, "setItem"> = localStorage
): void {
  storage.setItem(MOBILE_AUTH_STORAGE_KEY, JSON.stringify(session));
}

export function clearMobileAuthSession(
  storage: Pick<Storage, "removeItem"> = localStorage
): void {
  storage.removeItem(MOBILE_AUTH_STORAGE_KEY);
}
