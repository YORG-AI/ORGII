import type {
  MobileConnectionConfig,
  MobilePairedDesktopSummary,
} from "./types";

const MAX_PAIRED_DESKTOPS = 20;

export interface StoredPairedDesktop {
  id: string;
  name: string;
  config: MobileConnectionConfig;
  updatedAtMs: number;
}

export interface StoredPairingInventory {
  version: 1;
  activeDesktopId: string | null;
  desktops: StoredPairedDesktop[];
}

function isConnectionConfig(value: unknown): value is MobileConnectionConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as MobileConnectionConfig;
  return (
    (typeof config.wsUrl === "string" && !!config.wsUrl.trim()) ||
    (typeof config.host === "string" && !!config.host.trim())
  );
}

export function parsePairingInventory(
  raw: string | null
): StoredPairingInventory {
  if (!raw) return { version: 1, activeDesktopId: null, desktops: [] };
  try {
    const value = JSON.parse(raw) as Partial<StoredPairingInventory>;
    if (value.version !== 1 || !Array.isArray(value.desktops)) {
      throw new Error("Unsupported pairing inventory");
    }
    const desktops = value.desktops
      .filter(
        (desktop): desktop is StoredPairedDesktop =>
          !!desktop &&
          typeof desktop.id === "string" &&
          !!desktop.id &&
          typeof desktop.name === "string" &&
          !!desktop.name &&
          typeof desktop.updatedAtMs === "number" &&
          isConnectionConfig(desktop.config)
      )
      .slice(0, MAX_PAIRED_DESKTOPS);
    return {
      version: 1,
      activeDesktopId:
        typeof value.activeDesktopId === "string"
          ? value.activeDesktopId
          : null,
      desktops,
    };
  } catch {
    return { version: 1, activeDesktopId: null, desktops: [] };
  }
}

export function updatePairingInventory(
  inventory: StoredPairingInventory,
  config: MobileConnectionConfig | null,
  nowMs: number
): StoredPairingInventory {
  if (!config) return { ...inventory, activeDesktopId: null };
  const endpoint =
    config.wsUrl?.trim() ||
    [config.host?.trim(), config.port].filter(Boolean).join(":");
  const id = config.desktopId?.trim() || `endpoint:${endpoint}`;
  const desktop: StoredPairedDesktop = {
    id,
    name:
      config.deviceLabel?.trim() ||
      config.desktopId?.trim() ||
      config.host?.trim() ||
      "Paired Desktop",
    config,
    updatedAtMs: nowMs,
  };
  return {
    version: 1,
    activeDesktopId: id,
    desktops: [
      desktop,
      ...inventory.desktops.filter((candidate) => candidate.id !== id),
    ].slice(0, MAX_PAIRED_DESKTOPS),
  };
}

export function activePairingConfig(
  inventory: StoredPairingInventory
): MobileConnectionConfig | null {
  return (
    inventory.desktops.find(
      (desktop) => desktop.id === inventory.activeDesktopId
    )?.config ?? null
  );
}

export function selectPairingInventory(
  inventory: StoredPairingInventory,
  desktopId: string
): {
  inventory: StoredPairingInventory;
  config: MobileConnectionConfig;
} | null {
  const desktop = inventory.desktops.find(
    (candidate) => candidate.id === desktopId
  );
  if (!desktop) return null;
  return {
    inventory: { ...inventory, activeDesktopId: desktop.id },
    config: desktop.config,
  };
}

export function summarizePairingInventory(
  inventory: StoredPairingInventory
): MobilePairedDesktopSummary[] {
  return inventory.desktops.map(({ id, name, updatedAtMs }) => ({
    id,
    name,
    updatedAtMs,
    active: id === inventory.activeDesktopId,
  }));
}
