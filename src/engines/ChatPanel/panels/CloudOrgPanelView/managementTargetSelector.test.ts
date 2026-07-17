import { describe, expect, it } from "vitest";

import {
  buildCloudOrgSelectorValue,
  buildLocalRepoSelectorValue,
  buildLocalWorkspaceSelectorValue,
  parseManagementTarget,
} from "./managementTargetSelector";

describe("managementTargetSelector", () => {
  it("keeps cloud, local repo, and local workspace ids in separate namespaces", () => {
    const sharedId = "shared-id";

    expect(parseManagementTarget(buildCloudOrgSelectorValue(sharedId))).toEqual(
      { kind: "cloud-org", id: sharedId }
    );
    expect(
      parseManagementTarget(buildLocalRepoSelectorValue(sharedId))
    ).toEqual({ kind: "local-repo", id: sharedId });
    expect(
      parseManagementTarget(buildLocalWorkspaceSelectorValue(sharedId))
    ).toEqual({ kind: "local-workspace", id: sharedId });
  });

  it("rejects unknown and empty selector values", () => {
    expect(parseManagementTarget("unknown:value")).toBeNull();
    expect(parseManagementTarget("cloud:")).toBeNull();
    expect(parseManagementTarget("local-repo:")).toBeNull();
    expect(parseManagementTarget("local-workspace:")).toBeNull();
  });
});
