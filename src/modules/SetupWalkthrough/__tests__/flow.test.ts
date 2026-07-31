import { describe, expect, it } from "vitest";

import { DEFAULT_SETUP_WALKTHROUGH_PROGRESS } from "@src/config/settingsSchema/setupWalkthroughProgress";

import {
  advanceSetupProgress,
  applySetupOrganizationSelection,
  canCompleteSetupStep,
  canNavigateToSetupStep,
  captureSetupTeamPolicy,
  getVisibleSetupStepIds,
  setupTeamPolicyMatches,
} from "../flow";

describe("setup walkthrough flow", () => {
  it("keeps personal setup focused while team setup includes governance", () => {
    const focusedPath = [
      "goal",
      "tools",
      "basics",
      "tutorial",
      "work-model",
      "ready",
    ];

    expect(
      getVisibleSetupStepIds({
        ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
        goal: "personal",
      })
    ).toEqual(focusedPath);
    expect(
      getVisibleSetupStepIds({
        ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
        goal: "work_management",
      })
    ).toEqual(focusedPath);
    expect(
      getVisibleSetupStepIds({
        ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
        goal: "team_activity",
      })
    ).toEqual([
      "goal",
      "tools",
      "organization",
      "sharing",
      "basics",
      "tutorial",
      "work-model",
      "ready",
    ]);
  });

  it("does not advance until the current postcondition is true", () => {
    const blocked = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      goal: "team_activity" as const,
      currentStepId: "organization",
    };
    expect(advanceSetupProgress(blocked)).toBe(blocked);
    expect(
      advanceSetupProgress({ ...blocked, selectedOrgId: "org-1" }).currentStepId
    ).toBe("sharing");
  });

  it("requires an admin policy commit and a member sync check", () => {
    const base = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      goal: "team_activity" as const,
      selectedOrgId: "org-1",
    };
    expect(
      canCompleteSetupStep({ ...base, selectedOrgRole: "owner" }, "sharing")
    ).toBe(false);
    expect(
      canCompleteSetupStep({ ...base, selectedOrgRole: "member" }, "sharing")
    ).toBe(false);
    expect(
      canCompleteSetupStep(
        {
          ...base,
          selectedOrgRole: "member",
          verifiedAt: Date.now(),
        },
        "sharing"
      )
    ).toBe(true);
  });

  it("blocks jumping over unfinished steps", () => {
    const progress = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      goal: "personal" as const,
    };
    expect(canNavigateToSetupStep(progress, "ready")).toBe(false);
    expect(canNavigateToSetupStep(progress, "goal")).toBe(true);
  });

  it("preserves a same-org draft and hydrates a newly selected org", () => {
    const progress = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      selectedOrgId: "org-1",
      selectedOrgName: "Old name",
      repoScopes: ["github.com/acme/app"],
      sharingFloor: "full_replay" as const,
      inviteLink: "invite",
      verifiedAt: 123,
    };

    expect(
      applySetupOrganizationSelection(progress, {
        orgId: "org-1",
        name: "Renamed",
        role: "owner",
        repoScopes: [],
        sharingFloor: "off",
      })
    ).toMatchObject({
      selectedOrgName: "Renamed",
      repoScopes: ["github.com/acme/app"],
      sharingFloor: "full_replay",
      inviteLink: "invite",
      verifiedAt: 123,
    });

    expect(
      applySetupOrganizationSelection(progress, {
        orgId: "org-2",
        name: "Second org",
        role: "member",
        repoScopes: ["github.com/acme/other"],
        sharingFloor: "metadata_only",
      })
    ).toMatchObject({
      selectedOrgId: "org-2",
      repoScopes: ["github.com/acme/other"],
      sharingFloor: "metadata_only",
      inviteLink: null,
      verifiedAt: null,
    });
  });

  it("rejects a stale team-policy completion", () => {
    const progress = {
      ...DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
      selectedOrgId: "org-1",
      repoScopes: ["github.com/acme/app"],
      sharingFloor: "metadata_only" as const,
    };
    const snapshot = captureSetupTeamPolicy(progress);

    expect(snapshot).not.toBeNull();
    expect(setupTeamPolicyMatches(progress, snapshot!)).toBe(true);
    expect(
      setupTeamPolicyMatches(
        { ...progress, sharingFloor: "full_replay" },
        snapshot!
      )
    ).toBe(false);
  });
});
