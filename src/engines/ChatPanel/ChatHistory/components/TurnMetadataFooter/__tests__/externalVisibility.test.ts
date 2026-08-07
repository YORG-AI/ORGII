import { describe, expect, it } from "vitest";

import {
  EXTERNAL_TURN_METADATA_IDLE_GRACE_MS,
  externalTurnMetadataReadyAt,
} from "../externalVisibility";

describe("externalTurnMetadataReadyAt", () => {
  const lastEventAt = "2026-07-16T06:00:00.000Z";
  const lastEventMs = Date.parse(lastEventAt);

  it("waits one 3-second scan plus 10 idle seconds", () => {
    expect(externalTurnMetadataReadyAt(lastEventAt, 3_000)).toBe(
      lastEventMs + 13_000
    );
  });

  it("waits one 10-second scan plus 10 idle seconds", () => {
    expect(externalTurnMetadataReadyAt(lastEventAt, 10_000)).toBe(
      lastEventMs + 20_000
    );
  });

  it("keeps the idle grace explicit", () => {
    expect(EXTERNAL_TURN_METADATA_IDLE_GRACE_MS).toBe(10_000);
    expect(externalTurnMetadataReadyAt(undefined, 3_000)).toBeNull();
    expect(externalTurnMetadataReadyAt("invalid", 3_000)).toBeNull();
  });
});
