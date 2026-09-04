import type { TFunction } from "i18next";

import type { PairedDeviceInfo } from "@src/api/tauri/mobileRemote";

/** Devices seen within this window count as online. */
export const PAIRED_DEVICE_ONLINE_WINDOW_MS = 5 * 60 * 1000;

const GENERIC_DEVICE_LABELS = new Set(
  ["my phone", "orgii mobile", "phone", "mobile"].map((label) =>
    label.toLowerCase()
  )
);

/** Last segment of a UUID or the final 6 characters for disambiguation. */
export function shortDeviceIdSuffix(deviceId: string): string {
  const trimmed = deviceId.trim();
  if (!trimmed) return "??????";
  const compact = trimmed.replace(/-/g, "");
  if (compact.length >= 6) {
    return compact.slice(-6).toUpperCase();
  }
  return trimmed.slice(-6).toUpperCase();
}

export function isGenericPairedDeviceLabel(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized.length === 0 || GENERIC_DEVICE_LABELS.has(normalized);
}

export function isPairedDeviceOnline(
  lastSeenMs: number | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (lastSeenMs == null || lastSeenMs <= 0) {
    return false;
  }
  return nowMs - lastSeenMs <= PAIRED_DEVICE_ONLINE_WINDOW_MS;
}

export function formatPairedDeviceTitle(device: PairedDeviceInfo): string {
  const label = device.label.trim() || device.deviceId;
  const suffix = shortDeviceIdSuffix(device.deviceId);
  if (isGenericPairedDeviceLabel(device.label)) {
    return `${label} · ${suffix}`;
  }
  return `${label} · ${suffix}`;
}

export function formatPairedDeviceSubtitle(
  device: PairedDeviceInfo,
  formatTimestamp: (ms: number | null) => string,
  t: TFunction<"settings">
): string {
  const parts: string[] = [];
  parts.push(
    t("mobileRemote.devicePairedAt", {
      time: formatTimestamp(device.pairedAtMs),
    })
  );
  if (device.lastSeenMs != null && device.lastSeenMs > 0) {
    parts.push(
      t("mobileRemote.deviceLastSeenValue", {
        time: formatTimestamp(device.lastSeenMs),
      })
    );
  } else {
    parts.push(t("mobileRemote.deviceNeverSeen"));
  }
  return parts.join(" · ");
}

export function resolvePairedDevicePresence(
  lastSeenMs: number | null | undefined,
  nowMs: number = Date.now()
): "online" | "offline" {
  return isPairedDeviceOnline(lastSeenMs, nowMs) ? "online" : "offline";
}

/** Sort paired devices with the most recently seen first. */
export function comparePairedDevicesByLastSeen(
  a: PairedDeviceInfo,
  b: PairedDeviceInfo
): number {
  const aSeen = a.lastSeenMs ?? 0;
  const bSeen = b.lastSeenMs ?? 0;
  if (aSeen !== bSeen) {
    return bSeen - aSeen;
  }
  return b.pairedAtMs - a.pairedAtMs;
}

export function sortPairedDevicesByLastSeen(
  devices: readonly PairedDeviceInfo[]
): PairedDeviceInfo[] {
  return [...devices].sort(comparePairedDevicesByLastSeen);
}

export function formatPairedDeviceTierLabel(
  tier: string,
  t: TFunction<"settings">
): string {
  if (tier === "read_only") {
    return t("mobileRemote.deviceTierReadOnly");
  }
  return t("mobileRemote.deviceTierFull");
}

export function isPairedDeviceReadOnlyTier(tier: string): boolean {
  return tier === "read_only";
}

/** Default outdoor pairing label — unique enough for repeated QA pairings. */
export function suggestOutdoorPairingPhoneLabel(
  now: Date = new Date()
): string {
  const date = now.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = now.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `Phone · ${date} ${time}`;
}
