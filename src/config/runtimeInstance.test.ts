import { describe, expect, it } from "vitest";

import { runtimeInstanceProfileForIdentifier } from "./runtimeInstance";

describe("runtimeInstanceProfileForIdentifier", () => {
  it("keeps the primary runtime coordinates together", () => {
    expect(runtimeInstanceProfileForIdentifier("org2ai.org2")).toEqual({
      instanceId: 1,
      ideServerPort: 13_847,
      cliProxyPort: 17_888,
      authDeepLinkScheme: "orgii",
    });
  });

  it("offsets every isolated runtime coordinate together", () => {
    expect(
      runtimeInstanceProfileForIdentifier("org2ai.org2.instance2")
    ).toEqual({
      instanceId: 2,
      ideServerPort: 13_848,
      cliProxyPort: 17_889,
      authDeepLinkScheme: "orgii-instance2",
    });
  });

  it("falls back for malformed and unbounded identifiers", () => {
    for (const identifier of [
      "org2ai.org2.instance1",
      "org2ai.org2.instance100",
      "org2ai.org2.instance2.extra",
      "other.orgii.instance2",
    ]) {
      expect(runtimeInstanceProfileForIdentifier(identifier).instanceId).toBe(
        1
      );
    }
  });
});
