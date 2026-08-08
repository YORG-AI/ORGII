import { describe, expect, it } from "vitest";

import type { Org2CloudOrg } from "./org2CloudOrgsAtom";
import {
  buildOrg2CloudSyncRosterKey,
  shouldEnableExternalHistoryBackgroundScan,
} from "./useOrg2CloudSyncEngine";

describe("buildOrg2CloudSyncRosterKey", () => {
  const org: Org2CloudOrg = {
    orgId: "corg-1",
    name: "Cloud Team",
    role: "member",
  };

  it("invalidates the lifecycle key when background upload changes", () => {
    expect(buildOrg2CloudSyncRosterKey([org])).toBe(
      buildOrg2CloudSyncRosterKey([{ ...org, offlineSyncEnabled: false }])
    );
    expect(
      buildOrg2CloudSyncRosterKey([{ ...org, offlineSyncEnabled: true }])
    ).not.toBe(buildOrg2CloudSyncRosterKey([org]));
  });

  it("is stable across roster ordering", () => {
    const other = { ...org, orgId: "corg-2", name: "Other Team" };
    expect(buildOrg2CloudSyncRosterKey([org, other])).toBe(
      buildOrg2CloudSyncRosterKey([other, org])
    );
  });

  it("requires a loaded signed-in roster with at least one background org", () => {
    const backgroundOrg = { ...org, offlineSyncEnabled: true };
    expect(
      shouldEnableExternalHistoryBackgroundScan("identity-1", true, [
        backgroundOrg,
      ])
    ).toBe(true);
    expect(
      shouldEnableExternalHistoryBackgroundScan(null, true, [backgroundOrg])
    ).toBe(false);
    expect(
      shouldEnableExternalHistoryBackgroundScan("identity-1", false, [
        backgroundOrg,
      ])
    ).toBe(false);
    expect(
      shouldEnableExternalHistoryBackgroundScan("identity-1", true, [org])
    ).toBe(false);
  });
});
