import { invoke } from "@tauri-apps/api/core";

/**
 * Per-install cloud device identity from the `cloud_device_identity` command.
 *
 * `deviceId` is a UUIDv4 persisted at `~/.orgii/cloud_device_id` —
 * deliberately a SEPARATE id from the diagnostics install_id so member
 * runtime telemetry stays unlinkable from diagnostics. `machineLabel` is the
 * host name (falling back to a chip-derived label).
 */
export interface CloudDeviceIdentity {
  deviceId: string;
  machineLabel: string;
}

export async function cloudDeviceIdentity(): Promise<CloudDeviceIdentity> {
  return invoke<CloudDeviceIdentity>("cloud_device_identity");
}
