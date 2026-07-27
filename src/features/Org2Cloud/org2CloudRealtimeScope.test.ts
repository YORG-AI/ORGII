import { describe, expect, it } from "vitest";

import { resolveActiveRealtimeOrgId } from "./org2CloudRealtimeScope";

const ORGS = [{ orgId: "org-1" }, { orgId: "org-2" }];

describe("resolveActiveRealtimeOrgId", () => {
  it("subscribes only the actively selected member org", () => {
    expect(resolveActiveRealtimeOrgId(ORGS, "org-2")).toBe("org-2");
  });

  it("keeps org-wide channels closed in personal scope", () => {
    expect(resolveActiveRealtimeOrgId(ORGS, null)).toBeNull();
  });

  it("does not subscribe a removed or stale selected org", () => {
    expect(resolveActiveRealtimeOrgId(ORGS, "org-removed")).toBeNull();
  });

  it("prioritizes the visible management org over the sidebar filter", () => {
    expect(resolveActiveRealtimeOrgId(ORGS, "org-1", "org-2")).toBe("org-2");
  });

  it("rejects a stale management org instead of falling through silently", () => {
    expect(resolveActiveRealtimeOrgId(ORGS, "org-1", "org-removed")).toBeNull();
  });
});
