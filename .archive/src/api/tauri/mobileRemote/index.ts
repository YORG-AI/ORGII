/**
 * Mobile Remote Control API wrapper.
 *
 * Thin TypeScript wrappers around the `mobile_remote_*` Tauri commands
 * registered in `src-tauri/src/commands/handler_list.inc`. The Rust
 * commands return camelCase JSON (see `#[serde(rename_all = "camelCase")]`
 * on `PairingInitOutput` / `PairedDeviceInfo` / `RelayUrlInfo`), so the
 * types below mirror that wire shape directly — no conversion layer.
 */
import { invoke } from "@tauri-apps/api/core";

// ============================================================
// Types
// ============================================================

/**
 * Permission tier for a paired mobile device. Mirrors the Rust
 * `PermissionTier` enum's `serde(rename_all = "snake_case")` shape.
 */
export type PermissionTier = "read_only" | "full";

export const PERMISSION_TIER = {
  READ_ONLY: "read_only" as const,
  FULL: "full" as const,
} as const;

/** Output of `mobile_remote_pair_init`. */
export interface PairingInitOutput {
  pairingCode: string;
  confirmationPhrase: string;
  /** JSON-encoded payload the QR component renders directly. */
  qrPayload: string;
  expiresInSeconds: number;
}

/** One row in the paired-device list. */
export interface PairedDeviceInfo {
  deviceId: string;
  /**
   * Desktop the device is paired to. Required for the "set as primary"
   * affordance, which targets a desktop (not a device) at the relay layer.
   */
  desktopId: string;
  label: string;
  /** Wire string — narrowed via `PermissionTier` after parsing. */
  tier: string;
  isPrimary: boolean;
  pairedAtMs: number;
  lastSeenMs: number | null;
}

/** Snapshot of the relay URL config. */
export interface RelayUrlInfo {
  url: string;
  isDefault: boolean;
}

// ============================================================
// Commands
// ============================================================

/**
 * Begin a pairing session: asks the relay for a pairing code +
 * confirmation phrase and returns a payload ready to render as QR.
 */
export async function pairInit(args: {
  tier: PermissionTier;
  label: string;
  isPrimary: boolean;
}): Promise<PairingInitOutput> {
  const result = await invoke<unknown>("mobile_remote_pair_init", {
    tier: args.tier,
    label: args.label,
    isPrimary: args.isPrimary,
  });
  return result as PairingInitOutput;
}

/**
 * Confirm the SAS match on the desktop side. The relay records the
 * confirmation; the local device list is updated by the Rust side.
 */
export async function pairComplete(args: {
  pairingCode: string;
  tier: PermissionTier;
}): Promise<void> {
  await invoke<unknown>("mobile_remote_pair_complete", {
    pairingCode: args.pairingCode,
    tier: args.tier,
  });
}

/** Read the local cache of paired devices. */
export async function listDevices(): Promise<PairedDeviceInfo[]> {
  const result = await invoke<unknown>("mobile_remote_list_devices");
  return result as PairedDeviceInfo[];
}

/**
 * Reconcile the local cache against the relay's authoritative list.
 * Returns the post-sync list.
 */
export async function syncDevices(): Promise<PairedDeviceInfo[]> {
  const result = await invoke<unknown>("mobile_remote_sync_devices");
  return result as PairedDeviceInfo[];
}

/** Revoke a previously-paired device. */
export async function revokeDevice(deviceId: string): Promise<void> {
  await invoke<unknown>("mobile_remote_revoke_device", { deviceId });
}

/** Mark this desktop as the primary for the user account. */
export async function setPrimaryDesktop(desktopId: string): Promise<void> {
  await invoke<unknown>("mobile_remote_set_primary_desktop", { desktopId });
}

/** Persist a relay URL override (empty string resets to default). */
export async function setRelayUrl(url: string): Promise<void> {
  await invoke<unknown>("mobile_remote_set_relay_url", { url });
}

/** Read the current relay URL and whether it is the built-in default. */
export async function getRelayUrl(): Promise<RelayUrlInfo> {
  const result = await invoke<unknown>("mobile_remote_get_relay_url");
  return result as RelayUrlInfo;
}

export const mobileRemoteApi = {
  pairInit,
  pairComplete,
  listDevices,
  syncDevices,
  revokeDevice,
  setPrimaryDesktop,
  setRelayUrl,
  getRelayUrl,
};

export default mobileRemoteApi;
