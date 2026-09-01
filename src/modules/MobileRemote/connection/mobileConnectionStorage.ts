import type { MobileConnectionConfig } from "./types";

const SCOPED_STORAGE_PREFIX = "orgii-mobile-remote-config:user:";

export function mobileConnectionStorageKey(userId: string): string {
  return `${SCOPED_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

export function loadScopedMobileConnectionConfig(
  userId: string,
  storage: Pick<Storage, "getItem"> = localStorage
): MobileConnectionConfig | null {
  if (!userId.trim()) return null;
  try {
    const raw = storage.getItem(mobileConnectionStorageKey(userId));
    return raw ? (JSON.parse(raw) as MobileConnectionConfig) : null;
  } catch {
    return null;
  }
}

export function saveScopedMobileConnectionConfig(
  userId: string,
  config: MobileConnectionConfig | null,
  storage: Pick<Storage, "setItem" | "removeItem"> = localStorage
): void {
  if (!userId.trim()) return;
  const key = mobileConnectionStorageKey(userId);
  if (config) storage.setItem(key, JSON.stringify(config));
  else storage.removeItem(key);
}
