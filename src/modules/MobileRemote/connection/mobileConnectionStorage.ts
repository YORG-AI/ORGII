import {
  type StoredPairingInventory,
  activePairingConfig,
  parsePairingInventory,
  selectPairingInventory,
  summarizePairingInventory,
  updatePairingInventory,
} from "./mobilePairedDesktopInventory";
import type {
  MobileConnectionConfig,
  MobilePairedDesktopSummary,
} from "./types";

const SCOPED_STORAGE_PREFIX = "orgii-mobile-remote-config:user:";
const SCOPED_INVENTORY_PREFIX = "orgii-mobile-remote-pairings:user:";

export function mobileConnectionStorageKey(userId: string): string {
  return `${SCOPED_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

export function mobilePairedDesktopStorageKey(userId: string): string {
  return `${SCOPED_INVENTORY_PREFIX}${encodeURIComponent(userId)}`;
}

function readInventory(
  userId: string,
  storage: Pick<Storage, "getItem">
): StoredPairingInventory {
  return parsePairingInventory(
    storage.getItem(mobilePairedDesktopStorageKey(userId))
  );
}

export function loadScopedMobileConnectionConfig(
  userId: string,
  storage: Pick<Storage, "getItem">
): MobileConnectionConfig | null {
  if (!userId.trim()) return null;
  try {
    const inventory = readInventory(userId, storage);
    const active = activePairingConfig(inventory);
    if (active) return active;
    const raw = storage.getItem(mobileConnectionStorageKey(userId));
    return raw ? (JSON.parse(raw) as MobileConnectionConfig) : null;
  } catch {
    return null;
  }
}

export function saveScopedMobileConnectionConfig(
  userId: string,
  config: MobileConnectionConfig | null,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  nowMs = Date.now()
): void {
  if (!userId.trim()) return;
  const key = mobileConnectionStorageKey(userId);
  const inventory = readInventory(userId, storage);
  const nextInventory = updatePairingInventory(inventory, config, nowMs);
  if (!config) {
    storage.removeItem(key);
    if (inventory.desktops.length > 0) {
      storage.setItem(
        mobilePairedDesktopStorageKey(userId),
        JSON.stringify(nextInventory)
      );
    }
    return;
  }

  storage.setItem(key, JSON.stringify(config));
  storage.setItem(
    mobilePairedDesktopStorageKey(userId),
    JSON.stringify(nextInventory)
  );
}

export function listScopedMobilePairedDesktops(
  userId: string,
  storage: Pick<Storage, "getItem">
): MobilePairedDesktopSummary[] {
  if (!userId.trim()) return [];
  const inventory = readInventory(userId, storage);
  return summarizePairingInventory(inventory);
}

export function selectScopedMobilePairedDesktop(
  userId: string,
  desktopId: string,
  storage: Pick<Storage, "getItem" | "setItem">
): MobileConnectionConfig | null {
  if (!userId.trim() || !desktopId.trim()) return null;
  const selected = selectPairingInventory(
    readInventory(userId, storage),
    desktopId
  );
  if (!selected) return null;
  storage.setItem(
    mobilePairedDesktopStorageKey(userId),
    JSON.stringify(selected.inventory)
  );
  storage.setItem(
    mobileConnectionStorageKey(userId),
    JSON.stringify(selected.config)
  );
  return selected.config;
}
