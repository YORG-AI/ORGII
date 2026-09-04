import { describe, expect, it } from "vitest";

import type { PairedDeviceInfo } from "@src/api/tauri/mobileRemote";

import {
  comparePairedDevicesByLastSeen,
  formatPairedDeviceSubtitle,
  formatPairedDeviceTierLabel,
  formatPairedDeviceTitle,
  isGenericPairedDeviceLabel,
  isPairedDeviceOnline,
  isPairedDeviceReadOnlyTier,
  resolvePairedDevicePresence,
  shortDeviceIdSuffix,
  sortPairedDevicesByLastSeen,
  suggestOutdoorPairingPhoneLabel,
} from "../pairedDeviceDisplay";

function device(overrides: Partial<PairedDeviceInfo> = {}): PairedDeviceInfo {
  return {
    deviceId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    desktopId: "desktop-1",
    label: "My phone",
    tier: "full",
    isPrimary: false,
    pairedAtMs: 1_700_000_000_000,
    lastSeenMs: null,
    ...overrides,
  };
}

const t = ((key: string, values?: Record<string, string>) => {
  if (values) {
    return `${key}:${JSON.stringify(values)}`;
  }
  return key;
}) as Parameters<typeof formatPairedDeviceSubtitle>[2];

describe("shortDeviceIdSuffix", () => {
  it("returns the last six hex characters without hyphens", () => {
    expect(shortDeviceIdSuffix("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(
      "567890"
    );
  });
});

describe("isGenericPairedDeviceLabel", () => {
  it("flags common placeholder labels", () => {
    expect(isGenericPairedDeviceLabel("My phone")).toBe(true);
    expect(isGenericPairedDeviceLabel("ORGII Mobile")).toBe(true);
    expect(isGenericPairedDeviceLabel("Desktop browser QA rounds")).toBe(false);
  });
});

describe("formatPairedDeviceTitle", () => {
  it("appends a device suffix for disambiguation", () => {
    expect(formatPairedDeviceTitle(device())).toBe("My phone · 567890");
    expect(
      formatPairedDeviceTitle(device({ label: "Desktop browser QA rounds" }))
    ).toBe("Desktop browser QA rounds · 567890");
  });
});

describe("formatPairedDeviceSubtitle", () => {
  it("includes paired time, suffix, and last seen", () => {
    const subtitle = formatPairedDeviceSubtitle(
      device({ lastSeenMs: 1_700_000_100_000 }),
      (ms) => (ms == null ? "—" : `t:${ms}`),
      t
    );
    expect(subtitle).toContain("mobileRemote.devicePairedAt");
    expect(subtitle).toContain("mobileRemote.deviceLastSeenValue");
  });

  it("shows never seen when lastSeenMs is missing", () => {
    const subtitle = formatPairedDeviceSubtitle(device(), () => "never", t);
    expect(subtitle).toContain("mobileRemote.deviceNeverSeen");
  });
});

describe("isPairedDeviceOnline", () => {
  it("treats recent lastSeen as online", () => {
    const now = 1_700_000_000_000;
    expect(isPairedDeviceOnline(now - 60_000, now)).toBe(true);
    expect(isPairedDeviceOnline(now - 10 * 60_000, now)).toBe(false);
    expect(resolvePairedDevicePresence(now - 60_000, now)).toBe("online");
    expect(resolvePairedDevicePresence(null, now)).toBe("offline");
  });
});

describe("sortPairedDevicesByLastSeen", () => {
  it("orders devices by most recent lastSeen first", () => {
    const sorted = sortPairedDevicesByLastSeen([
      device({ deviceId: "old", lastSeenMs: 100 }),
      device({ deviceId: "recent", lastSeenMs: 300 }),
      device({ deviceId: "never", lastSeenMs: null }),
      device({ deviceId: "middle", lastSeenMs: 200 }),
    ]);
    expect(sorted.map((entry) => entry.deviceId)).toEqual([
      "recent",
      "middle",
      "old",
      "never",
    ]);
  });

  it("falls back to pairedAtMs when lastSeen ties", () => {
    expect(
      comparePairedDevicesByLastSeen(
        device({ deviceId: "a", pairedAtMs: 100, lastSeenMs: 500 }),
        device({ deviceId: "b", pairedAtMs: 200, lastSeenMs: 500 })
      )
    ).toBeGreaterThan(0);
  });
});

describe("formatPairedDeviceTierLabel", () => {
  it("maps tier wire values to localized labels", () => {
    expect(formatPairedDeviceTierLabel("full", t)).toBe(
      "mobileRemote.deviceTierFull"
    );
    expect(formatPairedDeviceTierLabel("read_only", t)).toBe(
      "mobileRemote.deviceTierReadOnly"
    );
    expect(isPairedDeviceReadOnlyTier("read_only")).toBe(true);
    expect(isPairedDeviceReadOnlyTier("full")).toBe(false);
  });
});

describe("suggestOutdoorPairingPhoneLabel", () => {
  it("includes date and time for uniqueness", () => {
    const label = suggestOutdoorPairingPhoneLabel(
      new Date("2026-09-04T14:30:00")
    );
    expect(label).toMatch(/^Phone · /);
    expect(label).toContain("Sep");
    expect(label).toContain("14:30");
  });
});
