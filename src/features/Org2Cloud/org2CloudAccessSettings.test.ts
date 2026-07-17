import { describe, expect, it } from "vitest";

import type {
  CloudAccessSettingsByOrg,
  CloudSharingFloorByOrg,
} from "./org2CloudAccessSettings";
import {
  createDefaultCloudOrgAccessSettings,
  floorAccessMode,
  getCloudOrgAccessSettings,
  getCloudSessionVisibility,
  getEffectiveCloudAccessMode,
  getOrgSharingFloor,
  isAccessModeAtLeast,
  resolveCloudPushAccess,
  withCloudOrgDefaultMode,
  withCloudSessionMode,
  withCloudSessionVisibility,
} from "./org2CloudAccessSettings";

const ORG = "corg-1";
const SID = "session-1";

function seeded(
  overrides: Partial<
    ReturnType<typeof createDefaultCloudOrgAccessSettings>
  > = {}
): CloudAccessSettingsByOrg {
  return { [ORG]: { ...createDefaultCloudOrgAccessSettings(), ...overrides } };
}

describe("cloud access ladder defaults (§13.4 privacy-first)", () => {
  it("defaults to OFF with no overrides", () => {
    const settings = createDefaultCloudOrgAccessSettings();
    expect(settings.defaultMode).toBe("off");
    expect(settings.sessionModes).toEqual({});
    expect(settings.sessionVisibility).toEqual({});
  });

  it("an unknown org resolves to the OFF defaults", () => {
    expect(getCloudOrgAccessSettings({}, ORG).defaultMode).toBe("off");
    expect(getEffectiveCloudAccessMode(undefined, SID)).toBe("off");
    expect(getCloudSessionVisibility(undefined, SID)).toBe("org");
  });
});

describe("getEffectiveCloudAccessMode", () => {
  it("uses the org default when no override exists", () => {
    const byOrg = seeded({ defaultMode: "full_replay" });
    expect(getEffectiveCloudAccessMode(byOrg[ORG], SID)).toBe("full_replay");
  });

  it("an explicit override wins in BOTH directions", () => {
    const up = seeded({ sessionModes: { [SID]: "full_replay" } }); // default off
    expect(getEffectiveCloudAccessMode(up[ORG], SID)).toBe("full_replay");
    const down = seeded({
      defaultMode: "full_replay",
      sessionModes: { [SID]: "off" },
    });
    expect(getEffectiveCloudAccessMode(down[ORG], SID)).toBe("off");
  });
});

describe("resolveCloudPushAccess (engine gate)", () => {
  it("returns null (skip, never uploaded) for effective off untagged", () => {
    expect(resolveCloudPushAccess(undefined, SID, false)).toBeNull();
    expect(resolveCloudPushAccess(seeded()[ORG], SID, false)).toBeNull();
  });

  it("floors a TAGGED effective-off session to metadata_only ('off' never reaches the wire)", () => {
    expect(resolveCloudPushAccess(seeded()[ORG], SID, true)).toEqual({
      accessMode: "metadata_only",
      visibility: "org",
    });
  });

  it("keeps the persisted restricted visibility on the tagged floor", () => {
    const byOrg = seeded({ sessionVisibility: { [SID]: "restricted" } });
    expect(resolveCloudPushAccess(byOrg[ORG], SID, true)).toEqual({
      accessMode: "metadata_only",
      visibility: "restricted",
    });
  });

  it("passes through metadata_only / full_replay with visibility", () => {
    const byOrg = seeded({
      defaultMode: "full_replay",
      sessionModes: { other: "off" },
    });
    expect(resolveCloudPushAccess(byOrg[ORG], SID, false)).toEqual({
      accessMode: "full_replay",
      visibility: "org",
    });
  });

  it("RATCHET: a persisted downgrade survives a later org-default raise", () => {
    // The 0010 review scenario: user restricts one session, then raises the
    // org default — an automated re-push must still resolve the persisted
    // per-session state, never rebuild from the (now permissive) default.
    let byOrg = seeded();
    byOrg = withCloudSessionMode(byOrg, ORG, SID, "metadata_only");
    byOrg = withCloudSessionVisibility(byOrg, ORG, SID, "restricted");
    byOrg = withCloudOrgDefaultMode(byOrg, ORG, "full_replay");
    expect(resolveCloudPushAccess(byOrg[ORG], SID, false)).toEqual({
      accessMode: "metadata_only",
      visibility: "restricted",
    });
    // Untouched sibling sessions DO follow the raised default.
    expect(resolveCloudPushAccess(byOrg[ORG], "session-2", false)).toEqual({
      accessMode: "full_replay",
      visibility: "org",
    });
  });
});

describe("org sharing floor (admin policy, 0002)", () => {
  it("getOrgSharingFloor defaults an unknown org to OFF (no floor)", () => {
    const byOrg: CloudSharingFloorByOrg = {};
    expect(getOrgSharingFloor(byOrg, ORG)).toBe("off");
    expect(getOrgSharingFloor({ [ORG]: "full_replay" }, ORG)).toBe(
      "full_replay"
    );
  });

  it("isAccessModeAtLeast ranks off < metadata_only < full_replay", () => {
    expect(isAccessModeAtLeast("off", "off")).toBe(true);
    expect(isAccessModeAtLeast("off", "metadata_only")).toBe(false);
    expect(isAccessModeAtLeast("metadata_only", "metadata_only")).toBe(true);
    expect(isAccessModeAtLeast("metadata_only", "full_replay")).toBe(false);
    expect(isAccessModeAtLeast("full_replay", "metadata_only")).toBe(true);
  });

  it("floorAccessMode raises up to the floor and no-ops otherwise", () => {
    expect(floorAccessMode("off", undefined)).toBe("off");
    expect(floorAccessMode("off", "off")).toBe("off");
    expect(floorAccessMode("off", "metadata_only")).toBe("metadata_only");
    expect(floorAccessMode("metadata_only", "full_replay")).toBe("full_replay");
    // Already at/above the floor is untouched.
    expect(floorAccessMode("full_replay", "metadata_only")).toBe("full_replay");
  });
});

describe("resolveCloudPushAccess with an org floor", () => {
  it("a metadata_only floor makes an effective-off UNTAGGED candidate push metadata (no longer skipped)", () => {
    // Without a floor this is null (see the untagged-off test above); the floor
    // forces the candidate on-wire at metadata_only.
    expect(resolveCloudPushAccess(seeded()[ORG], SID, false, "off")).toBeNull();
    expect(
      resolveCloudPushAccess(seeded()[ORG], SID, false, "metadata_only")
    ).toEqual({ accessMode: "metadata_only", visibility: "org" });
  });

  it("a full_replay floor lifts a metadata_only session to full replay", () => {
    const byOrg = seeded({ sessionModes: { [SID]: "metadata_only" } });
    expect(
      resolveCloudPushAccess(byOrg[ORG], SID, false, "full_replay")
    ).toEqual({ accessMode: "full_replay", visibility: "org" });
  });

  it("the floor preserves the persisted restricted visibility", () => {
    const byOrg = seeded({ sessionVisibility: { [SID]: "restricted" } });
    expect(
      resolveCloudPushAccess(byOrg[ORG], SID, false, "metadata_only")
    ).toEqual({ accessMode: "metadata_only", visibility: "restricted" });
  });

  it("a floor never LOWERS a member who already shares above it", () => {
    const byOrg = seeded({ defaultMode: "full_replay" });
    expect(
      resolveCloudPushAccess(byOrg[ORG], SID, false, "metadata_only")
    ).toEqual({ accessMode: "full_replay", visibility: "org" });
  });
});

describe("immutable update helpers", () => {
  it("withCloudOrgDefaultMode creates the org entry on demand and no-ops on same value", () => {
    const a = withCloudOrgDefaultMode({}, ORG, "metadata_only");
    expect(a[ORG].defaultMode).toBe("metadata_only");
    expect(withCloudOrgDefaultMode(a, ORG, "metadata_only")).toBe(a);
  });

  it("withCloudSessionMode(null) clears the override back to the default", () => {
    let byOrg = withCloudSessionMode({}, ORG, SID, "full_replay");
    expect(getEffectiveCloudAccessMode(byOrg[ORG], SID)).toBe("full_replay");
    byOrg = withCloudSessionMode(byOrg, ORG, SID, null);
    expect(byOrg[ORG].sessionModes).toEqual({});
    expect(getEffectiveCloudAccessMode(byOrg[ORG], SID)).toBe("off");
    // Clearing a non-existent override is a no-op (same reference).
    expect(withCloudSessionMode(byOrg, ORG, SID, null)).toBe(byOrg);
  });

  it("withCloudSessionVisibility stores only explicit restricted entries", () => {
    let byOrg = withCloudSessionVisibility({}, ORG, SID, "restricted");
    expect(byOrg[ORG].sessionVisibility).toEqual({ [SID]: "restricted" });
    byOrg = withCloudSessionVisibility(byOrg, ORG, SID, "org");
    expect(byOrg[ORG].sessionVisibility).toEqual({});
  });
});
