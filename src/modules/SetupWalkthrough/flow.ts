import type { SetupWalkthroughProgress } from "@src/config/settingsSchema/setupWalkthroughProgress";

export const SETUP_STEP_IDS = [
  "goal",
  "tools",
  "organization",
  "sharing",
  "basics",
  "tutorial",
  "work-model",
  "ready",
] as const;

export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

export interface SetupOrganizationSelection {
  orgId: string;
  name: string;
  role: string;
  repoScopes: string[];
  sharingFloor: SetupWalkthroughProgress["sharingFloor"];
}

export interface SetupTeamPolicySnapshot {
  selectedOrgId: string;
  repoScopes: string[];
  sharingFloor: SetupWalkthroughProgress["sharingFloor"];
}

/**
 * Selecting the same org is a harmless roster refresh and must not erase a
 * user's in-progress policy draft. A different org is a privacy boundary:
 * hydrate its known server mirrors and clear verification/invite state.
 */
export function applySetupOrganizationSelection(
  progress: SetupWalkthroughProgress,
  selection: SetupOrganizationSelection
): SetupWalkthroughProgress {
  if (progress.selectedOrgId === selection.orgId) {
    return {
      ...progress,
      selectedOrgName: selection.name,
      selectedOrgRole: selection.role,
    };
  }
  return {
    ...progress,
    selectedOrgId: selection.orgId,
    selectedOrgName: selection.name,
    selectedOrgRole: selection.role,
    repoScopes: selection.repoScopes,
    sharingFloor: selection.sharingFloor,
    inviteLink: null,
    verifiedAt: null,
  };
}

export function captureSetupTeamPolicy(
  progress: SetupWalkthroughProgress
): SetupTeamPolicySnapshot | null {
  return progress.selectedOrgId
    ? {
        selectedOrgId: progress.selectedOrgId,
        repoScopes: [...progress.repoScopes],
        sharingFloor: progress.sharingFloor,
      }
    : null;
}

export function setupTeamPolicyMatches(
  progress: SetupWalkthroughProgress,
  snapshot: SetupTeamPolicySnapshot
): boolean {
  return (
    progress.selectedOrgId === snapshot.selectedOrgId &&
    progress.sharingFloor === snapshot.sharingFloor &&
    progress.repoScopes.length === snapshot.repoScopes.length &&
    progress.repoScopes.every(
      (scope, index) => scope === snapshot.repoScopes[index]
    )
  );
}

export function isTeamSetup(progress: SetupWalkthroughProgress): boolean {
  return progress.goal === "team_activity";
}

export function getVisibleSetupStepIds(
  progress: SetupWalkthroughProgress
): SetupStepId[] {
  return isTeamSetup(progress)
    ? [...SETUP_STEP_IDS]
    : SETUP_STEP_IDS.filter(
        (step) => step !== "organization" && step !== "sharing"
      );
}

export function getNormalizedCurrentStep(
  progress: SetupWalkthroughProgress
): SetupStepId {
  const visible = getVisibleSetupStepIds(progress);
  return visible.includes(progress.currentStepId as SetupStepId)
    ? (progress.currentStepId as SetupStepId)
    : visible[0];
}

export function canCompleteSetupStep(
  progress: SetupWalkthroughProgress,
  stepId: SetupStepId
): boolean {
  switch (stepId) {
    case "goal":
      return progress.goal !== null;
    case "organization":
      return progress.selectedOrgId !== null;
    case "sharing":
      // Admin/owner onboarding proves a committed repo policy. Members cannot
      // mutate governance, but still explicitly request and drain one sync
      // pass before the team path is considered complete.
      return progress.selectedOrgRole === "member"
        ? progress.selectedOrgId !== null && progress.verifiedAt !== null
        : progress.repoScopes.length > 0 && progress.verifiedAt !== null;
    default:
      return true;
  }
}

export function advanceSetupProgress(
  progress: SetupWalkthroughProgress
): SetupWalkthroughProgress {
  const current = getNormalizedCurrentStep(progress);
  if (!canCompleteSetupStep(progress, current)) return progress;
  const visible = getVisibleSetupStepIds(progress);
  const index = visible.indexOf(current);
  const next = visible[Math.min(index + 1, visible.length - 1)];
  return {
    ...progress,
    currentStepId: next,
    completedStepIds: Array.from(
      new Set([...progress.completedStepIds, current])
    ),
  };
}

export function retreatSetupProgress(
  progress: SetupWalkthroughProgress
): SetupWalkthroughProgress {
  const visible = getVisibleSetupStepIds(progress);
  const current = getNormalizedCurrentStep(progress);
  const index = visible.indexOf(current);
  return {
    ...progress,
    currentStepId: visible[Math.max(0, index - 1)],
  };
}

export function canNavigateToSetupStep(
  progress: SetupWalkthroughProgress,
  target: SetupStepId
): boolean {
  const visible = getVisibleSetupStepIds(progress);
  const currentIndex = visible.indexOf(getNormalizedCurrentStep(progress));
  const targetIndex = visible.indexOf(target);
  return (
    targetIndex >= 0 &&
    (targetIndex <= currentIndex ||
      visible
        .slice(0, targetIndex)
        .every((step) => progress.completedStepIds.includes(step)))
  );
}
