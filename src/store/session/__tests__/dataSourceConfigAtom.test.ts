import { describe, expect, it } from "vitest";

import {
  DEFAULT_GLOBAL_FREQUENCY,
  FREQUENCY_INTERVAL_MS,
  GLOBAL_FREQUENCIES,
  getSourceConfig,
  normalizeScanFrequency,
} from "../dataSourceConfigAtom";

describe("external source scan frequencies", () => {
  it("offers only the requested automatic cadences plus manual", () => {
    expect(DEFAULT_GLOBAL_FREQUENCY).toBe("60s");
    expect(GLOBAL_FREQUENCIES).toEqual([
      "manual",
      "60s",
      "120s",
      "10m",
      "30m",
      "1h",
    ]);
    expect(FREQUENCY_INTERVAL_MS).toEqual({
      manual: null,
      "60s": 60_000,
      "120s": 120_000,
      "10m": 10 * 60_000,
      "30m": 30 * 60_000,
      "1h": 60 * 60_000,
    });
  });

  it("keeps 60s and migrates persisted values removed from the menu", () => {
    expect(normalizeScanFrequency("60s")).toBe("60s");
    expect(normalizeScanFrequency("5m")).toBe("10m");
    expect(normalizeScanFrequency("1d")).toBe("1h");

    expect(
      getSourceConfig(
        {
          codex_app: {
            enabled: true,
            frequency: "1d" as never,
            lastScannedAt: null,
          },
        },
        "codex_app"
      ).frequency
    ).toBe("1h");
  });
});
