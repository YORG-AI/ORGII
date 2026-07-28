import { describe, expect, it } from "vitest";

import {
  FULL_RECOVERY_COOLDOWN_MS,
  FULL_RECOVERY_DISCONNECT_MS,
  decideSubscribedEdgeRecovery,
} from "./org2CloudRealtimeRecovery";

const NOW = 1_000_000_000;

describe("decideSubscribedEdgeRecovery", () => {
  it("runs a full recovery on the first-ever edge for an org", () => {
    expect(
      decideSubscribedEdgeRecovery({
        nowMs: NOW,
        teardownAtMs: undefined,
        lastFullRecoveryAtMs: undefined,
      })
    ).toBe("full");
  });

  it("downgrades to delta after a short disconnect", () => {
    expect(
      decideSubscribedEdgeRecovery({
        nowMs: NOW,
        teardownAtMs: NOW - (FULL_RECOVERY_DISCONNECT_MS - 1),
        lastFullRecoveryAtMs: NOW - FULL_RECOVERY_DISCONNECT_MS * 10,
      })
    ).toBe("delta");
  });

  it("runs a full recovery after a long disconnect", () => {
    expect(
      decideSubscribedEdgeRecovery({
        nowMs: NOW,
        teardownAtMs: NOW - FULL_RECOVERY_DISCONNECT_MS,
        lastFullRecoveryAtMs: NOW - FULL_RECOVERY_DISCONNECT_MS * 10,
      })
    ).toBe("full");
  });

  it("downgrades rejoin storms inside the cooldown even without a teardown stamp", () => {
    expect(
      decideSubscribedEdgeRecovery({
        nowMs: NOW,
        teardownAtMs: undefined,
        lastFullRecoveryAtMs: NOW - (FULL_RECOVERY_COOLDOWN_MS - 1),
      })
    ).toBe("delta");
  });

  it("allows a full recovery again once the cooldown has passed", () => {
    expect(
      decideSubscribedEdgeRecovery({
        nowMs: NOW,
        teardownAtMs: NOW - FULL_RECOVERY_DISCONNECT_MS * 2,
        lastFullRecoveryAtMs: NOW - FULL_RECOVERY_COOLDOWN_MS,
      })
    ).toBe("full");
  });
});
